/**
 * Utility to simplify transcribing of outgoing media. Intended to be added to a Connection instead of media
 * */
class Transcriber {

    /**
     * Create a transcriber for a given track who allows you to set up the peer connection with the given quality transcription
     * */
    constructor(trackOrKind, trackSettings = {}) {
        this._trackOrKind = trackOrKind;
        this._trackSettings = trackSettings;
        this._kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
        this._qualities = {
            full: {
                video: {},
                audio: {},
            },
            high: {
                video: {
                    "maxFramerate": 60
                },
                audio: {}
            },
            medium: {
                video: {
                    "maxFramerate": 30
                },
                audio: {},
            },
            low: {
                video: {
                    "maxFramerate": 15,
                    "scaleResolutionDownBy": 2
                },
                audio: {},
            },
            micro: {
                video: {
                    "maxFramerate": 10,
                    "scaleResolutionDownBy": 4,
                    "maxBitrate": 8 * 1024 * 2,
                },
                audio: {
                    "maxBitrate": 8 * 1024 * 4,
                    // dtx: true // currently poor browser support, only moz ff >= v46
                }
            }
        };
    }

    _mergeRtpSettingsForTrack(rtpOptions){
        const trackSettingsCopy = Object.assign({}, this._trackSettings);
        if(!trackSettingsCopy.sendEncodings){
            trackSettingsCopy.sendEncodings = [rtpOptions];
        }else{
            trackSettingsCopy.sendEncodings.forEach(encoding => {
                Object.keys(rtpOptions).forEach(key => {
                    console.log(key, key in encoding);
                    if (!(key in encoding)) encoding[key] = rtpOptions[key];
                });
            });
        }
        return trackSettingsCopy;
    }

    /**
     * returns the track and the options to pass to addTransceiver.
     * You may use this like peerConnection.addTransceiver(...myTranscriber.transcribe('medium'));
     * @param quality [string] one of the quality settings of the transcriber (by default full, high, medium, low, micro)
     * @returns [trackOrKind, settings]
     * */
    transcribe(quality){
        quality = quality.toLowerCase();
        if(Object.keys(this._qualities).indexOf(quality) === -1) throw new Error('Unsupported quality option');
        return [this._trackOrKind, this._mergeRtpSettingsForTrack(this._qualities[quality][this._kind])];
    }

}

module.exports = Transcriber;