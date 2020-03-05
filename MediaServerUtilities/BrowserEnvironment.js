const puppeteer = require('puppeteer');
const read = require('fs').readFileSync;
const Tunnel = require('./Tunnel.js');
const Listenable = require('./Listenable.js');

/**
 * Allows controlling a headless browser and exchanging data with it
 * @class
 * @implements Listenable
 * */
class BrowserEnvironment extends Listenable(){

    static set debug(bool) {
        BrowserEnvironment._debug = bool;
    }

    static get debug() {
        return !!BrowserEnvironment._debug;
    }

    /**
     * @private
     * */
    static _getPuppet() {
        if (!BrowserEnvironment._browser) {
            const isDebug = BrowserEnvironment.debug;
            const flags = ["--allow-insecure-localhost","--autoplay-policy=no-user-gesture-required","--no-user-gesture-required"];
            if(isDebug) flags.push("--webrtc-event-logging");
            return puppeteer.launch({headless: !isDebug, devtools: isDebug, args: flags}).then(browser => {
                BrowserEnvironment._browser = browser;
                return browser;
            });
        }
        return Promise.resolve(BrowserEnvironment._browser);
    }

    /**
     * create a new browser environment with everything that belongs to a website opened by a browser
     * @param {string} id A unique identifier for the new environment
     * @param {Object} [config={}] Settings to use for the created environment
     * @param {string} [config.template] Path to the page template that the browser shall open. Works best with absolute paths
     * @param {Array} [config.scripts] A list of paths to scripts that shall be loaded into the open web page
     * @param {Object} [config.globals] A dictionary of globals to load into the web page opened by the browser. The key will be the global constants name
     * @param {boolean} [config.ignoreScriptOrder=false] Can be used to reduce the load- and start-time, if the order of the scripts does not matter. Otherwise, the scripts given will be loaded in the order they were given
     * */
    constructor(id, config = {}) {
        super();
        this._id = id;
        this._isInitialized = false;
        this._onInitializedCb = () => {};
        this._pageTemplate = config["template"] || null;
        this._customScripts = config["scripts"] || [];
        this._globals = config["globals"] || {};
        this._ignoreScriptOrder = config["ignoreScriptOrder"] || false;
        this._errorHandler = err => console.error(err);
    }

    async init() {
        if (this._isInitialized) throw new Error('ALREADY INITIALIZED');
        try {
            // load up a new browser context
            this._instance = await (await BrowserEnvironment._getPuppet()).newPage();
            const handleScript = script => this._instance.addScriptTag(typeof script === "string" ? {path: script.startsWith("http") ? script : require.resolve(script)} : script);
            /*
            * 1. open a tunnel to communicate between inside the browser context and outside (here, in the node module)
            * 2. set the globals
            * 3. add custom scripts either in given order or any order, according to config.ignoreScriptOrder
            * 4. set the page template, if defined
            */
            this.Tunnel = new Tunnel(this);
            await this.Tunnel.open();
            await Promise.all(Object.keys(this._globals).map(globalName => {
                this._instance.evaluate((globalName, globalValue) => window[globalName] = globalValue, [globalName, this._globals[globalName]])
            }));
            if (this._ignoreScriptOrder) {
                await Promise.all(this._customScripts.map(handleScript));
            } else {
                for (let script of this._customScripts) await handleScript(script);
            }
            if (this._pageTemplate) await this._instance.setContent(read(this._pageTemplate, 'utf-8'));
            await this._instance.evaluate(title => document.title = title, this._id);
            this._isInitialized = true;
            this._onInitializedCb();
            this.dispatchEvent('initialized');
            return this;
        } catch (err) {
            this._errorHandler(err);
            this.dispatchEvent('error');
        }
    }

    /**
     * @param cb [function] a function that is triggered, as soon as the environment is ready to be used.
     * If the function was registered after this is already the case, it is immediately triggered
     * */
    set onInitialized(cb) {
        this._onInitializedCb = cb;
        if (this._isInitialized) cb();
    }

    /**
     * flag indicating if the environment can be used already
     * @readonly
     * */
    get isInitialized() {
        return this._isInitialized;
    }

    /**
     * closes the browser environment and frees used resources
     * */
    async destroy() {
        this.dispatchEvent('destroy');
        return this._instance.close();
    }

}

module.exports = BrowserEnvironment;
