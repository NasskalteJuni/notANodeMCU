const Listenable = require('./Listenable.js');
const ID = () => new Date().getTime().toString(32) + Math.random().toString(32).substr(2,7);
const timestamp = () => new Date().toISOString();

/**
 * Introduces an abstraction layer around the RTCPeerConnection.
 * It uses a predefined signalling mechanism, handles common problems (short-time state errors, race-conditions) and
 * comfort functions (like accepting media-streams and transforming them into tracks or transceivers)
 * @class
 * @implements MediaConsuming
 * @implements Listenable
 * */
class Connection extends Listenable() {

    /**
     * Create a new connection object which connects 2 users
     * @param config
     * @param {string} [config.id=(autogenerated alphanumeric string)] Any sort of unique identifier, defaults to a random alphanumeric string
     * @param {string} config.peer The name or id of the other endpoint of this connection
     * @param {string} config.name The name of the user that is on this endpoint of the connection
     * @param {Signaler} config.signaler The signaling connection to use
     * @param {Array} [config.iceServers=[]] List of ice servers to use to establish the connection in the common RTCIceServers-format
     * @param {boolean} [config.useUnifiedPlan=true] Strongly recommended to not set this to false, Plan B semantic is deprecated and will not work with every funciton
     * @param {boolean} [config.isYielding] Defines if this end of the connection shall ignore and roll back session descriptions in favour to the other side. If omitted, a tiebraker is used to resolve conflicts, if set, you have to make sure that the other side has this set to the opposite value.
     * @param {boolean} [config.verbose=false] set to true to log the steps in the signalling and media handling process
     * @param {console} [config.logger=console] Logger to be used. Must implement the methods .log and .error. Defaults to console
     * */
    constructor({id = ID(), peer = null, name = null, signaler, iceServers = [], useUnifiedPlan = true, isYielding = undefined, verbose = false, logger=console} = {}) {
        super();
        this._signaler = signaler;
        this._connectionConfig = {iceServers, sdpSemantics: useUnifiedPlan ? 'unified-plan' : 'plan-b'};
        this._id = id;
        this._peer = peer;
        this._name = name || this._id;
        this._signaler.addEventListener('message', msg => this._handleSignallingMessage(msg));
        this._verbose = verbose;
        this._isYielding = isYielding === undefined ? (this._name ? this._name.localeCompare(this._peer) > 0 : false) : isYielding;
        this._offering = false;
        this._receivedStreams = [];
        this._receivedTracks = [];
        this._addedTracks = [];
        this._logger = logger;
        this._metaCache = {};
        this._unboundTransceivers = [];
        this._setupPeerConnection();
    }

    /**
     * the id of the connection
     * @readonly
     * */
    get id() {
        return this._id;
    }

    /**
     * the peer id which is the other endpoint of the connection
     * @readonly
     * */
    get peer() {
        return this._peer;
    }

    /**
     * property if logging is enabled
     * */
    get verbose() {
        return this._verbose;
    }
    set verbose(makeVerbose) {
        this._verbose = !!makeVerbose;
    }

    /**
     * Initiate all objects by registering the necessary event listeners
     * @private
     */
    _setupPeerConnection() {
        this._connection = new RTCPeerConnection(this._connectionConfig);
        this._connection.addEventListener('icecandidate', e => this._forwardIceCandidate(e.candidate));
        this._connection.addEventListener('negotiationneeded', () => this._startHandshake());
        this._connection.addEventListener('iceconnectionstatechange', () => this._handleIceChange());
        this._connection.addEventListener('track', ({track, streams}) => this._handleIncomingTrack(track, streams));
        this._connection.addEventListener('signalingstatechange', () => this._syncNewTransceivers());
        if (this._verbose) this._logger.log('created new peer connection (' + this._id + ') using ' + (this._connectionConfig.sdpSemantics === 'unified-plan' ? 'the standard' : 'deprecated chrome plan b') + ' sdp semantics');
    }

    /**
     * event handler that adds a newly received track to the list of received tracks, if it does not exist already.
     * Also checks, if a new Stream was added with the given track and adds this one, if necessary
     * @private
     * */
    _handleIncomingTrack(track, streams) {
        const newStreams = [];
        // handle chrome bug 835767 (remote audio not working with web audio api if not instantiated as element)
        if(track.kind === "audio"){
            const bugfix = document.createElement('audio');
            bugfix.muted = true;
            bugfix.autoplay = true;
            bugfix.srcObject = new MediaStream([track]);
        }
        const matches = this._connection.getTransceivers().filter(tr => tr.receiver.track && tr.receiver.track.id === track.id);
        const mid = matches.length > 0 ? matches[0].mid : null;
        if(this._metaCache[mid]){
            track.meta =  this._metaCache[mid];
            delete this._metaCache[mid];
        }
        this.dispatchEvent('trackadded', [track, mid]);
        streams.forEach(stream => {
            if (this._receivedStreams.findIndex(s => s.id === stream.id) === -1) {
                this._receivedStreams.push(stream);
                newStreams.push(stream);
                this.dispatchEvent('streamadded', [stream, track, mid]);
            }
        });
        this._receivedTracks.push(track);
        this.dispatchEvent('mediachanged', [{change: 'added', track, streams, peer: this._peer}]);
        track.addEventListener('ended', () => {
            this._receivedTracks = this._receivedTracks.filter(t => t.id !== track.id);
            this.dispatchEvent('mediachanged', [{change: 'removed', track, peer: this._peer, mid}]);
            this.dispatchEvent('trackremoved', [track, mid]);
            streams.forEach(stream => {
                if (!stream.active) {
                    this._receivedStreams = this._receivedStreams.filter(s => s.id !== stream.id);
                    this.dispatchEvent('streamremoved', [stream, track, mid]);
                }
            })
        });
        this.dispatchEvent('mediachanged', [{change: 'added', track, streams, newStreams, peer: this._peer, mid}]);
    }

    /**
     * sends generated ice candidates to the other peer
     * @private
     * */
    _forwardIceCandidate(candidate) {
        if (candidate !== null) {
            this._signaler.send({
                receiver: this._peer,
                data: candidate,
                sent: timestamp(),
                type: 'ice'
            });
        }
    }

    /**
     * handles incoming signalling messages
     * @private
     * */
    async _handleSignallingMessage(msg) {
        // when someone else sent the message, it is obviously of none interest to the connection between the peer and us
        if(msg.sender !== this._peer) return;
        const type = msg.type.toLowerCase();
        if(type === 'sdp'){
            await this._handleSdp(msg.data);
        }else if(type === 'ice'){
            await this._handleRemoteIceCandidate(msg.data)
        }else if(type === 'connection:close'){
            await this._handleClosingConnection();
        }else if(type === 'receiver:stop'){
            await this._stopReceiver(msg.data)
        }else if(type === 'track:meta'){
            this._changeMetaOfTrack(msg.data.mid, msg.data.meta);
        }else{
            if(this._verbose) this._logger.log('could not find handle for msg type',type,msg);
        }
    }


    /**
     * starts an attempt to establish a new peer connection to the other endpoint
     * @private
     * */
    async _startHandshake(){
        try{
            if(this._verbose) this._logger.log('negotiation is needed');
            this._offering = true;
            const offer = await this._connection.createOffer();
            if(this._connection.signalingState !== "stable") return;
            if (this._verbose) this._logger.log('set local description on connection ' + this._id + ':', this._connection.localDescription);
            await this._connection.setLocalDescription(offer);
            const msg = {
                receiver: this._peer,
                data: offer,
                type: 'sdp',
                sent: timestamp()
            };
            this._signaler.send(msg);
        }catch(err){
            this._logger.error(err);
        }finally{
            this._offering = false;
        }
    }

    /**
     * add incoming ice candidates
     * @private
     * */
    async _handleRemoteIceCandidate(candidate) {
        if (candidate !== null) await this._connection.addIceCandidate(candidate);
    }

    /**
     * handles incoming sdp messages by either setting or ignoring them (in case of a glare situation where this endpoint waits for the other sites answer)
     * @private
     * */
    async _handleSdp(description){
        if(this._verbose) this._logger.log('received sdp', description);
        try {
            const collision = this._connection.signalingState !== "stable" || this._offering;
            if(collision && this._verbose) this._logger.log("collision");
            if ((this._ignoredOffer = !this._isYielding && description.type === "offer" && collision)) {
                if(this._verbose) this._logger.log(this._id+' for '+this._peer+' ignored offer due to glare');
                return;
            } else if (collision && description.type === "offer"){
                if(this._verbose) this._logger.log(this._id+' for '+this._peer+' handles glare by yielding');
                await Promise.all([
                    this._connection.setLocalDescription({type: "rollback"}),
                    this._connection.setRemoteDescription(description)
                ]);
            }else{
                await this._connection.setRemoteDescription(description);
            }
            if (description.type === "offer") {
                await this._connection.setLocalDescription(await this._connection.createAnswer());
                this._signaler.send({type: 'sdp', receiver: this._peer, data: this._connection.localDescription, sent: timestamp()});
            }
        } catch (err) {
            this._logger.error(err);
        }
    }

    /**
     * @private
     * */
    _syncNewTransceivers(){
        const boundTransceivers = [];
        if(this._connection.signalingState === "stable"){
            this._unboundTransceivers.forEach((transceiver, index) => {
               const binding = this._connection.getTransceivers().filter(tr => tr === transceiver);
               if(binding.length){
                   const bound = binding[0];
                   boundTransceivers.push(bound);
                   if(bound.sender.track && bound.sender.track.meta) this._signaler.send({type: "track:meta", data: {mid: bound.mid, meta: bound.sender.track.meta}, receiver: this._peer});
               }
            });
        }
        this._unboundTransceivers = this._unboundTransceivers.filter(tr => boundTransceivers.indexOf(tr) === -1);
    }

    /**
     * adds a media track to the connection, but with more options than addTrack, since transceiver based
     * @param {MediaStreamTrack|MediaStreamTrackKind} track what kind of media should be added
     * @param {Array|RTCTransceiverConfig} streams allows passing either the array of streams associated with this track or a config object
     * @private
     * */
    _addTrackToConnection(track, streams = []) {
        this._addedTracks.push(track);
        if (this._verbose) this._logger.log('add track to connection ' + this._id, track);
        const config = {
            direction: "sendonly",
            streams
        };
        this._unboundTransceivers.push(this._connection.addTransceiver(track, streams instanceof Array ? config : streams));
    }

    /**
     * remove a transceiver for a track to a connection
     * Does not handle invalid or any kind of input, only the specified
     * track [MediaStreamTrack|string] the track or trackKind (a string equal to "video", "audio" or "*", case sensitive)
     * @private
     * */
    _removeTrackFromConnection(track) {
        let removed = 0;
        const searchingTrackKind = typeof track === "string";
        const searchingActualTrack = track instanceof MediaStreamTrack;
        if(searchingActualTrack) this._addedTracks = this._addedTracks.filter(tr => tr.id !== track.id);
        else this._addedTracks = this._addedTracks.filter(tr => track !== '*' && tr.kind !== track);
        this._connection.getTransceivers().forEach(transceiver => {
            // we obviously only remove our own tracks, therefore searching 'recvonly'-transceivers makes no sense
            if (transceiver.direction === "sendrecv" || transceiver.direction === "sendonly") {
                const tr = transceiver.sender.track;
                if (tr && (searchingActualTrack && tr.id === track.id) || (searchingTrackKind && (tr.kind === track || track === '*'))) {
                    // mute the given track, removing its content
                    this._connection.removeTrack(transceiver.sender);
                    if (transceiver.direction === "sendrecv") transceiver.direction = "recvonly";
                    else transceiver.direction = "inactive";
                    this._signaler.send({
                        receiver: this._peer,
                        type: 'receiver:stop',
                        data: transceiver.mid,
                        sent: timestamp()
                    });
                    removed++;
                }
            }
        });
        if (this._verbose) this._logger.log('removed ' + removed + ' tracks from connection ' + this._id);
    }

    /**
     * handles the missing stop call to transceivers in chrome by stopping the track on the remote side instead.
     * This method is called on the remote side
     * @private
     * */
    _stopReceiver(mid){
        this._connection.getTransceivers().filter(tr => tr.mid === mid).map(tr => tr.receiver.track).forEach(track=> {
            track.stop();
            // we have to stop the track, since Chrome misses the transceiver.stop() implementation,
            // but calling stop will not fire the ended event, so we have to fire it instead...
            track.dispatchEvent(new Event('ended'));
        });
    }

    /**
     * changes additional info of a received track, if it does not find the track or something else is wrong, this method fails silently.
     * @private
     * */
    _changeMetaOfTrack(mid, meta){
        if(this._verbose) console.log('meta of track bound to transceiver '+mid+' will change to '+meta);
        const matches = this._connection.getTransceivers().filter(tr => tr.mid === mid);
        if(matches.length && matches[0].receiver.track){
            const track = matches[0].receiver.track;
            track.meta = meta;
            track.dispatchEvent(new Event('metachanged'));
        }else{
            this._metaCache[mid] = meta;
        }
    }

    /**
     * replaces a track or every track of a matching type with the given replacement track
     * @private
     * */
    _replaceTrack(searchTrack, replacementTrack) {
        const searchingActualTrack = searchTrack instanceof MediaStreamTrack;
        const searchingTrackKind = typeof searchTrack === "string" && (searchTrack === "audio" || searchTrack === "video" || searchTrack === '*');
        const i = this._addedTracks.findIndex(tr => (searchingActualTrack && tr.id === searchTrack.id) || (searchingTrackKind && (tr.kind === searchTrack || searchTrack === '*')));
        if(i !== -1) this._addedTracks[i] = replacementTrack;
        this._connection.getTransceivers().forEach(transceiver => {
            // again, we only replace our own tracks, no need to look at 'recvonly'-transceivers
            if (transceiver.direction === "sendrecv" || transceiver.direction === "sendonly") {
                if (transceiver.sender.track && (searchingActualTrack && transceiver.sender.track.id === searchTrack.id) || (searchingTrackKind && transceiver.sender.track.kind === searchTrack)) {
                    transceiver.sender.replaceTrack(replacementTrack);
                    if(replacementTrack instanceof MediaStreamTrack) this._signaler.send({type: "track:meta", data: {mid: transceiver.mid, meta: track.meta || ""}, receiver: this._peer});
                }
            }
        })
    }

    /**
     * mutes a given track or all tracks of the matching kind
     * @param track [MediaStreamTrack|MediaStreamTrackKind|'*']
     * @param muted [boolean=true] if set to false, this method unmutes a previously muted track
     * @private
     * */
    _muteTrack(track, muted=true){
        const searchingActualTrack = track instanceof MediaStreamTrack;
        const searchingTrackKind = typeof track === "string" && (['audio', 'video', '*'].indexOf(track) >= 0);
        this._connection.getTransceivers().forEach(transceiver => {
            if((searchingActualTrack && transceiver.sender.track.id === track.id) || (searchingTrackKind && (track === '*' || transceiver.sender.track.kind === track))){
                if(muted){
                    if(!transceiver.sender._muted){
                        transceiver.sender._muted = transceiver.sender.track;
                        transceiver.sender.replace(null)
                    }
                }else{
                    if(transceiver.sender._muted){
                        transceiver.sender.replace(transceiver.sender._muted);
                        delete transceiver.sender['_muted'];
                    }
                }
            }
        });
    }

    /**
     * reacts to ice state changes. this is either used to detect disconnection or ice gathering problems and react accordingly
     * (by setting the state to closed or restart the ice process)
     * @private
     * */
    _handleIceChange() {
        // if the other side is away, close down the connection
        if (this._connection.iceConnectionState === "disconnected"){
            this._connection.close();
            this.dispatchEvent('close', []);
        }
        // if the connection failed, restart the ice gathering process according to the spec, will lead to negotiationneeded event
        if(this._connection.iceConnectionState === "failed"){
            this._connection.restartIce();
        }
    }

    /**
     * add media to the connection
     * @param {MediaStreamTrack|string} trackOrKind A track or its kind
     * @param {Array|RTCRtpTransceiverInit} streamsOrTransceiverConfig The streams that the given track belongs to or a config object for the transceiver to use
     * */
    /**
     * add media to the connection
     * @param {MediaStream|MediaStreamTrack|MediaStreamConstraints} media A MediaStream, which tracks will be added, a single MediaStreamTrack, which will be added or the MediaStreamConstraints, which will be used to retrieve the local MediaStreamTracks
     * */
    async addMedia(media) {
        if (arguments.length === 2) {
            this._addTrackToConnection(arguments[0], arguments[1]);
        } else {
            if (media instanceof MediaStream) {
                media.getTracks().forEach(track => {
                    if(stream.meta) track.meta = stream.meta;
                    this._addTrackToConnection(track, [media])
                });
            } else if (media instanceof MediaStreamTrack) {
                this._addTrackToConnection(media, [new MediaStream([media])]);
            } else if (typeof media === "string" && ["audio", "video", "*"].indexOf(media) >= 0) {
                this._addTrackToConnection(media, [new MediaStream([])]);
            } else {
                this._logger.error('unknown media type', typeof media, media);
            }
        }
    }

    /**
     * removes the given media from the connection
     * @param {MediaStream|MediaStreamTrack|MediaStreamTrackOrKind} [media]
     * allows to remove all media from the given stream or stream description ("audio" removing all tracks of kind audio, no argument or '*' removing all media)
     * */
    removeMedia(media) {
        if (media instanceof MediaStream) {
            media.getTracks().forEach(track => this._removeTrackFromConnection(track));
        } else if ((media instanceof MediaStreamTrack) || (typeof media === "string" && ["audio", "video", "*"].indexOf(media) >= 0)) {
            this._removeTrackFromConnection(media);
        } else if(typeof media === undefined || arguments.length === 0 || (typeof media === "string" && media === "*")){
            this._removeTrackFromConnection("*");
        } else {
            this._logger.error('unknown media type', typeof media, media);
        }
    }

    /**
     * All non-muted received tracks of the given connection
     * @readonly
     * */
    get tracks() {
        return this._receivedTracks;
    }

    /**
     * All active received streams of the given connection
     * @readonly
     * */
    get streams() {
        return this._receivedStreams.filter(stream => stream.active);
    }

    /**
     * all locally added tracks of the given connection
     * @readonly
     * */
    get addedTracks(){
        return this._addedTracks;
    }

    /**
     * handles the command of the remote side to shut down the connection
     * @private
     * */
    _handleClosingConnection() {
        if(this._verbose) this._logger.log('connection closing down');
        this._receivedTracks.forEach(track => {
            track.stop();
            track.dispatchEvent(new Event('ended'));
        });
        this._connection.close();
        this.dispatchEvent('close');
    }

    /**
     * close the connection
     * */
    close() {
        const msg = {
            receiver: this._peer,
            data: 'immediately',
            type: 'connection:close',
            sent: timestamp()
        };
        this._signaler.send(msg);
        this._connection.close();
        this.dispatchEvent('close');
    }

    /**
     * Is the connection closed or still open
     * @readonly
     * */
    get closed() {
        return this._connection.connectionState === "closed" || this._connection.signalingState === "closed";
    }

}

module.exports = Connection;