const ConnectionManager = require('./ConnectionManager.js');
const Connection = require('./ConnectionWithRollback.js');
const VideoMixer = require('./VideoMixer.js');
const AudioMixer = require('./AudioMixer.js');
const Listenable = require('./Listenable.js');
const SpeakerConfig = require('./VideoMixingConfigurations/Speaker.js');
const SpeechDetection = require('./SpeechDetection.js');
const Architecture = require('./_Architecture.js');

module.exports = class Conference extends Listenable(){

    constructor({name, signaler, verbose = false, logger = console, architecture= 'mesh', video = {width: 420, height: 360}}){
        super();
        this._name = name;
        this._signaler = signaler;
        this._peers = new ConnectionManager({signaler, name, verbose, logger});
        this._sfu = new Connection({signaler, name, peer: '@server', verbose, logger});
        this._mcu = new Connection({signaler, name, peer: '@server', verbose, logger});
        this._speechDetection = new SpeechDetection({threshold: 65});
        this._videoMixer = new VideoMixer();
        this._videoMixer.addConfig(new SpeakerConfig(this._speechDetection), 'speaker');
        this._audioMixer = new AudioMixer(video);
        this._architecture = new Architecture(architecture);
        this._addedMedia = [];
        this._display = null;
        signaler.addEventListener('message', message => {
            console.log(message);
            if(message.type === 'architecture:switch'){
                this._handleArchitectureSwitch(message.data);
            }
        });
        this._peers.addEventListener('trackadded', (track, user) => {
            if(this._architecture.value === 'mesh'){
                this._videoMixer.addMedia(track, 'peers-'+track.id);
                if(track.kind === "audio") this._speechDetection.addMedia(track, 'peers-'+user);
            }
        });
        this._sfu.addEventListener('trackadded', track => {
            if(this._architecture.value === 'sfu'){
                this._videoMixer.addMedia(track, 'sfu-'+track.meta);
                if(track.kind === "audio") this._speechDetection.addMedia(track, 'sfu-'+track.meta);
            }
        });
        this._peers.addEventListener('userconnected', user => this.dispatchEvent('userconnected', [user]));
        this._peers.addEventListener('userdisconnected', user => this.dispatchEvent('userdisconnected', [user]));
    }

    get architecture(){
        return this._architecture.value;
    }

    get members(){
        return this._peers.users;
    }

    _getArchitectureHandler(name = null){
        if(name === null) name = this._architecture.value;
        const architectures = {mesh: this._peers, mcu: this._mcu, sfu: this._sfu};
        return architectures[name];
    }

    _handleArchitectureSwitch(newArchitecture){
        const previousArchitecture = this._architecture.value;
        this._architecture.value = newArchitecture;
        this._addedMedia.forEach(m => this._getArchitectureHandler(newArchitecture).addMedia(m));
        if(newArchitecture === 'mesh'){
            this._clearLocalMediaProcessors();
            // TODO: make this more standardized by using it like sfu or mcu, maybe via track.meta
            this._getArchitectureHandler('mesh').users.forEach(user => {
                this._getArchitectureHandler('mesh').get(user).tracks.forEach(track => {
                    this._addTrackToLocalMediaProcessors(track, user)
                });
            });
        }else if(newArchitecture === 'sfu'){
            this._clearLocalMediaProcessors();
            this._getArchitectureHandler('sfu').tracks.forEach(track => {
                this._addTrackToLocalMediaProcessors(track, track.meta);
            });
        }
        this._updateDisplayedStream();
        this._getArchitectureHandler(previousArchitecture).removeMedia();
        this.dispatchEvent('architectureswitched', [newArchitecture, previousArchitecture]);
    }

    _clearLocalMediaProcessors(){
        this._videoMixer.removeMedia();
        this._speechDetection.removeMedia();
        this._audioMixer.removeMedia();
    }

    _addTrackToLocalMediaProcessors(track, id){
        if(track.kind === "video"){
            this._videoMixer.addMedia(track, id)
        }else{
            this._audioMixer.addMedia(track, id);
            this._speechDetection.addMedia(track, id)
        }
    }

    get out(){
        if(this._architecture.value === 'mcu'){
            return this._mcu.streams[0];
        }else{
            return new MediaStream([this._videoMixer.outputTrack, this._audioMixer.outputTrack]);
        }
    }

    async addWebcam(config = {video: true, audio: true}){
        const stream = await window.navigator.mediaDevices.getUserMedia(config);
        stream.meta = this.name+'-webcam';
        this.addMedia(stream);
    }

    async addMedia(m){
        if(!m.meta) m.meta = this._name;
        this._getArchitectureHandler().addMedia(m);
        if(this._architecture.value !== 'mcu') this._speechDetection.addMedia(m);
        this._addedMedia.push(m);
    }

    /**
     * define on which video element the conference should be displayed on
     * @param element the element to use as a display. Can be a video element or a query selector string to find one
     * */
    displayOn(element){
        if(typeof element === 'string') element = document.querySelector(element);
        this._display = element;
        this._updateDisplayedStream();
    }

    /**
     * @private
     * */
    _updateDisplayedStream(){
        if(this._display){
            this._display.srcObject = this.out;
            if(this._display.paused) this._display.play();
        }
    }

};