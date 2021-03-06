const BrowserEnvironment = require('../../MediaServerUtilities/BrowserEnvironment.js');
BrowserEnvironment.debug = true;
const env = new BrowserEnvironment('mcu', {scripts: [require.resolve('../../dist/mediautils.js'), require.resolve('./mediaServerClientFile.js')]});
env.init().then(() => console.log('started browser environment'));

module.exports = env;