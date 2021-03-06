/**
 * gather stats and save them or their accumulated results into an object
 * @private
 * */
function getRelevantValues(statValueDict){
    // define the form of the output
    const val = {
        inbound: {
            bytes: 0,
            packets: 0,
            packetLoss: 0,
            framesReceived: 0,
            resolution: "0/0",
            audioEnergy: 0
        },
        outbound: {
            bytes: 0,
            packets: 0,
            packetLoss: 0,
            framesPerSecond: 0,
            resolution: "0/0",
            audioEnergy: 0
        },
        time: 0
    };

    // iterate over each gathered stat report and take the required values
    for(let stat of statValueDict){
        if(stat.type === 'inbound-rtp'){
            val.inbound.bytes += stat.bytesReceived;
            val.inbound.packets += stat.packetsReceived;
            val.inbound.packetLoss += stat.packetsLost;
        }else if(stat.type === 'outbound-rtp'){
            val.outbound.bytes += stat.bytesSent;
            val.outbound.packets += stat.packetsSent;
        }else if(stat.type === 'remote-inbound-rtp'){
            val.outbound.packetLoss += stat.packetsLost;
        }else if(stat.type === 'peer-connection'){
            val.time = stat.timestamp;
        }else if(stat.type === 'track' && stat.framesReceived !== undefined){
            val.inbound.framesReceived = stat.framesReceived;
            val.inbound.resolution = stat.frameWidth+'/'+stat.frameHeight;
        }else if(stat.type === 'media-source' && stat.framesPerSecond !== undefined){
            val.outbound.framesPerSecond = stat.framesPerSecond;
            val.outbound.resolution = stat.width+'/'+stat.height;
        }else if(stat.type === 'media-source' && stat.totalAudioEnergy !== undefined){
            val.outbound.audioEnergy = stat.totalAudioEnergy;
        }else if(stat.type === 'track' && stat.totalAudioEnergy !== undefined){
            val.inbound.audioEnergy = stat.totalAudioEnergy;
        }
    }
    return val;
}

/**
 * get a report of the inbound and outbound byte and packet transmission rate as also the packet-loss for this peer connection as an Object
 * @param {RTCPeerConnection} rtcPeerConnection the connection used to gather stats from
 * @param {Number} [watchTime=1000] the time to gather the data transmission rates in milliseconds. Defaults to 1 Second, ergo 1000 ms.
 * @return Promise resolves with an performance report Object containing inbound and outbound dictionaries with the keys bytes, packets and packetLoss
 * @private
 * */
async function getReport(rtcPeerConnection, watchTime = 1000){
    return new Promise(async(resolve, reject) => {
        try{
            const statsAtStart = (await rtcPeerConnection.getStats()).values();
            setTimeout(async () => {
                const statsAtEnd = (await rtcPeerConnection.getStats()).values();
                const valuesAtStart = getRelevantValues(statsAtStart);
                const valuesAtEnd = getRelevantValues(statsAtEnd);
                const duration = valuesAtEnd.time - valuesAtStart.time;
                resolve({
                    inbound: {
                        bytes: valuesAtEnd.inbound.bytes-valuesAtStart.inbound.bytes,
                        packets: valuesAtEnd.inbound.packets-valuesAtStart.inbound.packets,
                        packetLoss: valuesAtEnd.inbound.packetLoss-valuesAtStart.inbound.packetLoss,
                        totalPacketLoss: valuesAtEnd.inbound.packetLoss,
                        fps: valuesAtEnd.inbound.framesReceived-valuesAtStart.inbound.framesReceived,
                        audioEnergy: valuesAtEnd.inbound.audioEnergy,
                        resolution: valuesAtEnd.inbound.resolution,
                        tracks: rtcPeerConnection.getTransceivers().filter(tr => tr.currentDirection !== "inactive" && (tr.direction === "sendrecv" || tr.direction === "recvonly") && tr.receiver.track && tr.receiver.track.readyState === "live").length
                    },
                    outbound: {
                        bytes: valuesAtEnd.outbound.bytes-valuesAtStart.outbound.bytes,
                        packets: valuesAtEnd.outbound.packets-valuesAtStart.outbound.packets,
                        packetLoss: valuesAtEnd.outbound.packetLoss-valuesAtStart.outbound.packetLoss,
                        totalPacketLoss: valuesAtEnd.outbound.packetLoss,
                        fps: valuesAtEnd.outbound.framesPerSecond,
                        audioEnergy: valuesAtEnd.outbound.audioEnergy,
                        resolution: valuesAtEnd.outbound.resolution,
                        tracks: rtcPeerConnection.getTransceivers().filter(tr => tr.currentDirection !== "inactive" && (tr.direction === "sendrecv" || tr.direction === "sendonly") && tr.sender.track && tr.sender.track.readyState === "live").length
                    },
                    duration,
                    timestamp: new Date().toISOString(),
                });
            }, watchTime);
        }catch(err){
            reject(err);
        }
    });

}

module.exports = getReport;