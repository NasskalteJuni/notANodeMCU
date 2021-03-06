const ConnectionManager = require('./ConnectionManager.js');
const Connection = require('./ConnectionWithSignaledLock.js');
const Listenable = require('./Listenable.js');
const SpeechDetection = require('./SpeechDetection.js');
const Architecture = require('./_Architecture.js');

/**
 * Utility to transmit your media to other conference members using a specified architecture
 * @class
 * */
class Conference extends Listenable(){

    /**
     * create a new conference that exchanges your media streams with other conference members using multiple architectures,
     * like the simple peer to peer model 'mesh' or the architecture 'mcu', that uses a media server to mix streams
     * @param {Object} config
     * @param {String} config.name your username in the conference
     * @param {Signaler} config.signaler The signaler to use to communicate the necessary data to transmit media between the conference members
     * @param {String} [config.architecture='mesh'] The architecture (name) to start with. Defaults to the purely peer to peer based mesh model
     * @param {Array} [config.iceServers=[]] The ice servers to use, in the common RTCIceServer-format
     * @param {Console} [config.logger=console] The logger to use. Anything with .log() and .error() method should work. Defaults to the browser console
     * @param {Boolean} [config.verbose=false] If you want to log (all) information or not
     * */
    constructor({name, signaler, architecture= 'mesh', iceServers = [], verbose = false, logger = console}){
        super();
        this._name = name;
        this._signaler = signaler;
        this._verbose = verbose;
        this._logger = logger;
        this._peers = new ConnectionManager({signaler, name, iceServers, verbose, logger});
        this._sfu = new Connection({signaler, name, iceServers, peer: '@sfu', isYielding: false, verbose, logger});
        this._mcu = new Connection({signaler, name, iceServers, peer: '@mcu', isYielding: false, verbose, logger});
        this._speechDetection = new SpeechDetection({threshold: 65});
        this._updateInterval = this._createUpdateInterval();
        this._architecture = new Architecture(architecture);
        this._addedMedia = [];
        this._display = null;
        signaler.addEventListener('message', message => {
            if(message.type === 'architecture:switch'){
                this._handleArchitectureSwitch(message.data);
            }
        });
        this._peers.addEventListener('userconnected', user => this._handleUserConnected(user));
        this._peers.addEventListener('mediachanged', () => this._displayEveryTrack());
        this._peers.addEventListener('userdisconnected', user => this._handleUserDisconnected(user));
        this._peers.addEventListener('connectionclosed', user => {
            if(this._architecture.value === 'mesh'){
                this._speechDetection.removeMedia(user);
                this._hideTrackOfUser(user)
            }
        });
        this._handleArchitectureSwitch(this._architecture.value);
        this._displayEveryTrack();
    }

    /**
     * the name of the architecture currently used
     * @readonly
     * */
    get architecture(){
        return this._architecture.value;
    }

    /**
     * the current conference members
     * @readonly
     * */
    get members(){
        return this._peers.users;
    }

    /**
     * get the current or specified architecture connection(s)
     * @private
     * */
    _getArchitectureHandler(name = null){
        if(name === null) name = this._architecture.value;
        const architectures = {mesh: this._peers, mcu: this._mcu, sfu: this._sfu};
        return architectures[name];
    }

    /**
     * @private
     * */
    _removeEventListeners(){
        ['mesh', 'sfu'].forEach(architecture => {
            const eventToFnMapping = {trackadded: this._addTrackHandler.bind(this), trackremoved: this._removeTrackHandler.bind(this)};
            Object.keys(eventToFnMapping).forEach(e => this._getArchitectureHandler(architecture).removeEventListener(e, eventToFnMapping[e]));
        });
        this._getArchitectureHandler('mcu').removeEventListener('trackadded', "track => this._displayTrackOfUser('mcu', track)");
    }



    /**
     * when notified to switch to another architecture, use the next architecture model to transmit and receive media and display it
     * @private
     * */
    _handleArchitectureSwitch(newArchitecture){
        const previousArchitecture = this._architecture.value;
        this._architecture.value = newArchitecture;
        this._addedMedia.forEach(m => this._getArchitectureHandler(newArchitecture).addMedia(m));
        if(newArchitecture === 'mesh'){
            this._multipleIncomingConnectionsSwitch();
        }else if(newArchitecture === 'sfu'){
            this._multipleIncomingConnectionsSwitch();
        }else if(newArchitecture === 'mcu'){
            this._clearDisplay();
            this._removeEventListeners();
            const video = this._createVideoElement(this._displayId('mcu'));
            video.srcObject = this._getArchitectureHandler('mcu').streams[0];
            video.style.width = "100%";
            video.style.height = "100%";
            video.style.zIndex = "1";
            this._display.appendChild(video);
            this._getArchitectureHandler('mcu').addEventListener('trackadded', track => this._displayTrackOfUser('mcu', track));
            this.dispatchEvent('mediachanged', []);
        }
        this._getArchitectureHandler(previousArchitecture).removeMedia();
        this.dispatchEvent('architectureswitched', [newArchitecture, previousArchitecture]);
    }


    _multipleIncomingConnectionsSwitch(){
        this._clearDisplay();
        this._removeEventListeners();
        this._displayOwnMedia();
        this._displayEveryTrack();
        this._getArchitectureHandler().addEventListener('trackadded', this._addTrackHandler.bind(this));
        this._getArchitectureHandler().addEventListener('trackremoved', this._removeTrackHandler.bind(this));
    }

    _addTrackHandler(track){
        if(track.meta){
            if(this._verbose) this._logger.log('add track for '+track.meta+' to conference');
            this._displayTrackOfUser(track.meta, track);
            if(track.kind === "audio") this._speechDetection.addMedia(track, track.meta);
        }else{
            track.addEventListener('metachanged', () => this._addTrackHandler(track));
        }
    }

    _removeTrackHandler(track){
        if(track.meta) this._hideTrackOfUser(track.meta, track);
    }



    /**
     * @private
     * */
    _handleUserConnected(user){
        this.dispatchEvent('userconnected', [user]);
        // mcu or sfu take care of automatic forwarding, but mesh needs to add media itself
        if(this._architecture.value === 'mesh'){
            this._addedMedia.forEach(m => this._getArchitectureHandler('mesh').get(user).addMedia(m));
        }
    }

    /**
     * @private
     * */
    _handleUserDisconnected(user){
        this.dispatchEvent('userdisconnected', [user]);
        if(this._architecture.value === 'mesh'){
            if(this._getArchitectureHandler('mesh').get(user)) this._getArchitectureHandler('mesh').get(user).close()
        }
        if(this._architecture.value !== 'mcu'){
            this._hideTrackOfUser(user);
        }
    }

    /**
     * switches the used architecture to the given one
     * @param {String} [name=nextArchitectureValue] the architecture to switch to
     * */
    switchArchitecture(name=undefined){
        if(name === undefined) name = this._architecture.nextValue();
        if(this._verbose) this._logger.log('request switching to architecture', name);
        let msg = {type: 'architecture:switch', receiver: '@server', data: name};
        this._signaler.send(msg);
    }

    /**
     * switches to the architecture that comes after the current architecture in the order of architectures (standard: mesh -> sfu -> mcu -> mesh)
     * */
    nextArchitecture(){
        this.switchArchitecture(this._architecture.nextValue());
    }

    /**
     * the architecture that is used after the current architecture
     * @returns {String} the architecture name
     * */
    get nextArchitectureValue(){
        return this._architecture.nextValue();
    }

    /**
     * switches to the architecture that is before the current one in the order of architectures to use (standard: mesh -> sfu -> mcu -> mesh)
     * */
    previousArchitecture(){
        this.switchArchitecture(this._architecture.prevValue());
    }

    /**
     * the architecture that is used before the current architecture
     * @returns {String} the architecture name
     * */
    get prevArchitectureValue(){
        return this._architecture.prevValue();
    }



    /**
     * The stream of the conference
     * @returns MediaStream a mediastream containing all received media
     * */
    get out(){
        if(this._architecture.value === 'mcu'){
            return this._mcu.streams[0];
        }else{
            return new MediaStream([this._getArchitectureHandler().tracks])
        }
    }

    /**
     * activates your webcam and adds the stream to the connection
     * @param {Object} [config={video:true, audio:true}] the webcam configuration to use
     * */
    async addWebcam(config = {video: true, audio: true}){
        const stream = await window.navigator.mediaDevices.getUserMedia(config);
        this.addMedia(stream);
    }

    /**
     * mutes (or unmutes) added media
     * @param {String|MediaStream|MediaStreamTrack} m The media to mute. Defaults to all media "*" but can be any stream, track or media kind ("video", "audio" or "*")
     * @param {Boolean} [mute=true] a flag which indicates if you want to mute media, or unmute muted media. Muting muted or unmuting not muted Media has no effect.
     * */
    muteMedia(m="*", mute=true){
        this._getArchitectureHandler().muteMedia(m, mute);
    }

    /**
     * add media to the connection
     * @param {MediaStream|MediaStreamTrack} m The media to add. This can be a stream or a single track
     * */
    async addMedia(m){
        console.log('added media', m);
        if(!m.meta) m.meta = this._name;
        this._getArchitectureHandler().addMedia(m);
        this._addedMedia.push(m);
        this._speechDetection.addMedia(m, this._name);
        if(m instanceof MediaStream){
            m.getTracks().forEach(tr => this._displayTrackOfUser(this._name, tr));
        }else{
            this._displayTrackOfUser(this._name, m);
        }
    }

    _removeMediaFromAdded(m){
        this._addedMedia = this._addedMedia.filter(added => {
            if(typeof m === "string"){
                m = m.toLocaleLowerCase();
                if(added instanceof MediaStreamTrack){
                    return added.kind !== m || m !== "*"
                }else if(added instanceof MediaStream){
                    added.getTracks().filter(track => track.kind !== m || m !== "*").forEach(track => added.removeTrack(track));
                    return added.getTracks().length > 0
                }
            }else if(m instanceof MediaStream){
                if(added instanceof MediaStream){
                    return added.id !== m.id;
                }else if(added instanceof MediaStreamTrack){
                    return m.getTracks().findIndex(track => track.id === added.id) === -1;
                }
            }else if(m instanceof MediaStreamTrack){
                if(added instanceof MediaStream){
                    added.getTracks().forEach(track => {
                        if(track.id === m.id) added.removeTrack(track);
                    });
                    return added.getTracks().length > 0;
                }else if(added instanceof MediaStreamTrack){
                    return m.id !== added.id;
                }
            }
        });
    }

    /**
     * remove media from the conference
     * @param {String|MediaStream|MediaStreamTrack} [m="*"] the media to remove. Can be a media type like audio, video or "*" for all, a track or a stream
     * */
    removeMedia(m = "*"){
        if(m instanceof MediaStream){
            m.getTracks().forEach(track => {
                this._getArchitectureHandler().removeMedia(track);
                if(this._architecture.value !== 'mcu') this._hideTrackOfUser(this._name, track);
            })
        }else if(m instanceof MediaStreamTrack){
            this._getArchitectureHandler().removeMedia(m);
            if(this._architecture.value !== 'mcu') this._hideTrackOfUser(this._name, m);
        }else if(typeof m === "string" && ["video", "audio", "*"].indexOf(m.toLowerCase()) >= 0){
            m = m.toLowerCase();
            this._getArchitectureHandler().removeMedia(m);
            const el = this._display.querySelector('#'+this._displayId(this._name));
            if(el) el.srcObject.getTracks().filter(tr => m === '*' || tr.kind === m).forEach(tr => this._hideTrackOfUser(this._name, tr));
        }else{
            console.log('unknown media type', m)
        }
        this._removeMediaFromAdded(m);
    }

    _createUpdateInterval(){
        setInterval(() => {
            if(this._architecture.value !== 'mcu' && this._display){
                const height = display.getBoundingClientRect().height;
                const width = display.getBoundingClientRect().width;
                const smallVideoWidth = 80;
                const smallVideoHeight = 60;
                const silence = this._speechDetection.silence;
                this._display.style.backgroundColor = silence ? "rgb(20,20,20)" : "rgb(100,200,250)";
                const noiseOffset = 5;
                const silenceOffset = 2;
                let big = this._name;
                let speaker = this._speechDetection.lastSpeaker;
                if(speaker && this._display.querySelector('#'+this._displayId(speaker))){
                    big = speaker;
                }
                const bigVideo = this._display.querySelector('#'+this._displayId(big));
                if(bigVideo){
                    bigVideo.style.zIndex = "1";
                    bigVideo.style.height = (silence ? (height - 2*silenceOffset) : (height - 2*noiseOffset))+"px";
                    bigVideo.style.width = (silence ? (width - 2*silenceOffset) : (width - 2*noiseOffset))+"px";
                    bigVideo.style.left = (silence ? silenceOffset : noiseOffset)+"px";
                    bigVideo.style.top = (silence ? silenceOffset : noiseOffset)+"px";
                }
                this._peers.users.concat([this._name]).filter(u => u !== big).sort().forEach((u, i) => {
                    const smallVideo = this._display.querySelector('#'+this._displayId(u));
                    if(smallVideo){
                        smallVideo.style.zIndex = "2";
                        smallVideo.style.width = smallVideoWidth+"px";
                        smallVideo.style.height = smallVideoHeight+"px";
                        smallVideo.style.left = (((smallVideoWidth+1) * i)+noiseOffset)+"px";
                        smallVideo.style.top = (height-(smallVideoHeight+noiseOffset))+"px";
                    }
                });
            }
        }, 100);
    }

    _displayId(user){
        return '__display-'+user;
    }

    _displayTrackOfUser(user, track){
        console.log("add track of user ",user,track, this._display);
        if(!this._display) return;
        const id = this._displayId(user);
        let video = this._display.querySelector('#'+id);
        if(!video){
            video = this._createVideoElement(id);
            if(this._name === user) video.muted = true;
            this._display.appendChild(video);
        }
        if(!video.srcObject) video.srcObject = new MediaStream([]);
        video.srcObject.getTracks().filter(tr => track.kind === tr.kind).forEach(tr => video.srcObject.removeTrack(tr));
        video.srcObject.addTrack(track);
    }

    _hideTrackOfUser(user, track){
        if(!this._display) return;
        const id = this._displayId(user);
        let video = this._display.querySelector('#'+id);
        if(video){
            if(track) video.srcObject.getTracks().filter(tr => tr.id === track.id).forEach(tr => video.srcObject.removeTrack(tr));
            else video.parentNode.removeChild(video);
        }
    }

    _displayEveryTrack(){
        if(this._architecture.value === "mesh"){
            this._getArchitectureHandler("mesh").users.forEach(user => {
                this._getArchitectureHandler("mesh").get(user).tracks.forEach(tr => this._displayTrackOfUser(user, tr))
            });
        }else if(this._architecture.value === "sfu"){
            this._getArchitectureHandler("sfu").tracks.filter(tr => tr.meta).forEach(tr => this._displayTrackOfUser(tr.meta, tr));
        }else if(this._architecture.value === "mcu"){
            this._getArchitectureHandler("mcu").tracks.forEach(tr => this._displayTrackOfUser('mcu', tr));
        }
    }

    _displayOwnMedia(){
        this._addedMedia.forEach(m => {
            if(m instanceof MediaStreamTrack) this._displayTrackOfUser(this._name, m);
            if(m instanceof MediaStream) m.getTracks().forEach(tr => this._displayTrackOfUser(this._name, tr));
        });
    }

    _clearDisplay(){
        if(this._display) this._display.innerHTML = "";
    }


    _createVideoElement(id){
        const video = document.createElement('video');
        video.setAttribute('id', id);
        video.autoplay = true;
        video.poster = "";
        video.srcObject = new MediaStream([]);
        video.style.zIndex = "0";
        video.style.height = "60px";
        video.style.width = "80px";
        video.style.left = "0px";
        video.style.top = "0px";
        video.style.position = "absolute";
        return video;
    }

    /**
     * define inside which element the conference should be displayed on
     * @param {Node|String} element the element to use as a container. Can be a div (or similar) or a query selector string to find one
     * @return {Node} the container element
     * */
    displayOn(element){
        if(typeof element === 'string') element = document.querySelector(element);
        this._display = element;
        this._display.style.position = "relative";
        this._display.style.overflow = "hidden";
        this._display.style.left = "0px";
        this._display.style.top = "0px";
        if(this._verbose) this._logger.log('display output inside', element);
        this._handleArchitectureSwitch(this._architecture.value);
    }


    /**
     * Get the number of media objects that you added. This is not equal to the number of MediaStreamTracks, since added MediaStreams also count just as one
     * @return Number the number of media added
     * */
    get numberOfAddedMedia(){
        return this._addedMedia.length;
    }

    /**
     * Get the number of added MediaStreamTracks to the connection
     * @return Number the number of tracks added (as tracks only or as part of a stream)
     * */
    get addedTracks(){
       return this.addedMedia.reduce((count, m) => m instanceof MediaStream ? count+m.getTracks().length : count+1, 0);
    }

    /**
     * Close down any connections of any used architecture
     * */
    close(){
        [this._peers, this._sfu, this._mcu].forEach(architecture => architecture.close());
        this._addedMedia = [];
        clearInterval(this._updateInterval);
    }

    /**
     * A conference is closed if at least one connection in use is closed
     * @readonly
     * */
    get closed(){
        return [this._peers, this._sfu, this._mcu].reduce((isClosed, architecture) =>architecture.closed || isClosed, false)
    }

};

module.exports = Conference;