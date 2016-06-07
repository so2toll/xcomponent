
import postRobot from 'post-robot/src';
import { SyncPromise as Promise } from 'sync-browser-mocks/src/promise';
import { BaseComponent } from './base';
import { urlEncode, popup, noop, extend, getElement, getParentWindow, once, iframe, onCloseWindow, getParentNode, denodeify, memoize, createElement } from '../lib';
import { CONSTANTS, CONTEXT_TYPES, MAX_Z_INDEX } from '../constants';
import { PopupOpenError } from '../error';

let activeComponents = [];

let RENDER_DRIVERS = {

    [ CONTEXT_TYPES.IFRAME ]: {

        overlay: false,

        open(element) {

            this.iframe = iframe(element, null, {
                name: this.childWindowName,
                width: this.component.dimensions.width,
                height: this.component.dimensions.height
            });

            this.registerForCleanup(() => {
                if (this.iframe) {
                    this.iframe.parentNode.removeChild(this.iframe);
                    delete this.iframe;
                }
            });

            this.setForCleanup('context', CONSTANTS.CONTEXT.IFRAME);
            this.setForCleanup('window', this.iframe.contentWindow);

            this.watchForClose();

            return this;
        },

        renderToParent(element) {
            // pass
        }
    },

    [ CONTEXT_TYPES.POPUP ]: {

        overlay: true,

        open() {

            let pos = this.getPosition();

            this.popup = popup('about:blank', {
                name: this.childWindowName,
                width: this.component.dimensions.width,
                height: this.component.dimensions.height,
                top: pos.y,
                left: pos.x
            });

            this.registerForCleanup(() => {
                if (this.popup) {
                    this.popup.close();
                    delete this.popup;
                }
            });

            if (!this.popup || this.popup.closed || typeof this.popup.closed === 'undefined') {
                throw new PopupOpenError(`[${this.component.tag}] Can not open popup window - blocked`);
            }

            this.setForCleanup('context', CONSTANTS.CONTEXT.POPUP);
            this.setForCleanup('window', this.popup);

            this.watchForClose();

            return this;
        },

        renderToParent() {
            this.childWindowName = this.getChildWindowName({ proxy: true });
            this.openPopup();
        }
    },

    [ CONTEXT_TYPES.LIGHTBOX ]: {

        overlay: true,

        open() {

            this.openIframe(document.body);

            let pos = this.getPosition();

            this.iframe.style.zIndex = MAX_Z_INDEX;
            this.iframe.style.position = 'absolute';
            this.iframe.style.left = pos.x;
            this.iframe.style.top = pos.y;
            this.iframe.style.borderRadius = '10px';

            return this;
        },

        renderToParent() {
            // pass
        }
    }
};


export class ParentComponent extends BaseComponent {

    constructor(component, options = {}) {
        super(component, options);
        this.component = component;


        // Ensure the component is not loaded twice on the same page, if it is a singleton

        if (component.singleton && activeComponents.some(comp => comp.component === component)) {
            throw new Error(`${component.tag} is a singleton, and an only be instantiated once`);
        }

        activeComponents.push(this);

        this.validate(options);
        this.parentWindow = getParentWindow();

        this.setProps(options.props || {});

        // Options passed during renderToParent

        this.childWindowName = options.childWindowName || this.getChildWindowName();

        this.screenWidth = options.screenWidth || window.outerWidth;
        this.screenHeight = options.screenHeight || window.outerHeight;
    }

    setProps(props) {
        this.props = this.normalizeProps(props);
        this.url   = this.getUrl();
    }

    getUrl() {

        let url;

        if (this.props.url) {
            url = this.props.url;
        } else if (this.props.env) {
            url = this.component.envUrls[this.props.env];
        } else {
            url = this.component.url;
        }

        let queryString = this.propsToQuery(this.props);

        if (queryString) {
            url = `${ url }${ url.indexOf('?') === -1 ? '?' : '&' }${ queryString }`;
        }

        return url;
    }

    updateProps(props) {
        return Promise.resolve().then(() => {

            let oldProps = JSON.stringify(this.props);

            let newProps = {};
            extend(newProps, this.props);
            extend(newProps, props);

            this.setProps(newProps);

            if (this.window && oldProps !== JSON.stringify(this.props)) {
                return postRobot.send(this.window, CONSTANTS.POST_MESSAGE.PROPS, {
                    props: this.props
                });
            }
        });
    }

    validate(options) {

        if (options.timeout) {
            let timeout = parseInt(options.timeout, 10);

            if (typeof timeout !== 'number' || isNaN(timeout)) {
                throw new Error(`[${this.component.tag}] Expected options.timeout to be a number: ${options.timeout}`);
            }
        }

        if (options.container && !this.component.context.iframe) {
            throw new Error(`[${this.component.tag}] Can not render to a container: does not support iframe mode`);
        }

        if (options.env && (!this.component.envUrls[options.env])) {
            throw new Error(`[${this.component.tag}] Invalid env: ${options.env}`);
        }
    }

    normalizeProps(props) {

        this.validateProps(props);

        props = props || {};
        let result = {};

        for (let key of Object.keys(this.component.props)) {

            let prop = this.component.props[key];
            let value = props[key];

            let hasProp = props.hasOwnProperty(key) && value !== null && value !== undefined && value !== '';

            if (!hasProp && prop.def) {
                value = (prop.def instanceof Function && prop.type !== 'function') ? prop.def() : prop.def;
            } else if (!hasProp && prop.defaultProp) {
                value = props[prop.defaultProp];
            }

            if (prop.type === 'boolean') {
                result[key] = Boolean(value);

            } else if (prop.type === 'function') {

                if (!value) {

                    if (!value && prop.noop) {
                        value = noop;
                    }

                } else {

                    if (prop.denodeify) {
                        value = denodeify(value);
                    }

                    if (prop.once) {
                        value = once(value);
                    }

                    if (prop.memoize) {
                        value = memoize(value);
                    }
                }

                result[key] = value;

            } else if (prop.type === 'string') {
                result[key] = value || '';

            } else if (prop.type === 'object') {
                result[key] = JSON.stringify(value);

            } else if (prop.type === 'number') {
                result[key] = parseInt(value || 0, 10);
            }
        }

        return result;
    }

    propsToQuery(props) {

        return Object.keys(props).map(key => {

            let value = props[key];

            if (!value) {
                return '';
            }

            let result;

            if (typeof value === 'boolean') {
                result = '1';
            } else if (typeof value === 'string') {
                result = value.toString();
            } else if (typeof value === 'function') {
                return;
            } else if (typeof value === 'object') {
                result = JSON.stringify(value);
            } else if (typeof value === 'number') {
                result = value.toString();
            }

            return `${urlEncode(key)}=${urlEncode(result)}`;

        }).filter(Boolean).join('&');
    }

    getPosition() {

        let pos = {};
        let dimensions = this.component.dimensions;

        if (typeof dimensions.x === 'number') {
            pos.x = dimensions.x;
        } else {
            let width = this.screenWidth;

            if (width <= dimensions.width) {
                pos.x = 0;
            } else {
                pos.x = Math.floor((width / 2) - (dimensions.width / 2));
            }
        }

        if (typeof dimensions.y === 'number') {
            pos.y = dimensions.y;
        } else {

            let height = this.screenHeight;

            if (height <= dimensions.height) {
                pos.y = 0;
            } else {
                pos.y = Math.floor((height / 2) - (dimensions.height / 2));
            }
        }

        return pos;
    }

    getRenderContext(el) {

        if (el && this.component.contexts[CONTEXT_TYPES.IFRAME]) {
            return CONTEXT_TYPES.IFRAME;
        }

        if (this.component.defaultContext) {

            if (this.component.defaultContext === CONTEXT_TYPES.LIGHTBOX) {
                return CONTEXT_TYPES.LIGHTBOX;
            }

            if (this.component.defaultContext === CONTEXT_TYPES.POPUP) {
                return CONTEXT_TYPES.POPUP;
            }
        }

        if (this.component.contexts[CONTEXT_TYPES.LIGHTBOX]) {
            return CONTEXT_TYPES.LIGHTBOX;

        }

        if (this.component.contexts[CONTEXT_TYPES.POPUP]) {
            return CONTEXT_TYPES.POPUP;
        }
    }





    render(element, renderContext) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Component is already rendered`);
        }

        if (renderContext && !this.component.contexts[renderContext]) {
            throw new Error(`Invalid context: ${renderContext}`);
        }

        renderContext = renderContext || this.getRenderContext(element);

        for (let context of [ renderContext, CONTEXT_TYPES.POPUP, CONTEXT_TYPES.IFRAME, CONTEXT_TYPES.LIGHTBOX ]) {

            if (!context || !this.component.contexts[context]) {
                continue;
            }

            let driver = RENDER_DRIVERS[context];

            try {
                driver.open.call(this, element);
            } catch (err) {

                if (err instanceof PopupOpenError) {
                    continue;
                }

                throw err;
            }

            this.listen(this.window);
            this.loadUrl(this.url);
            this.runTimeout();

            if (driver.overlay) {
                this.createOverlay();
            }

            return;
        }

        throw new Error(`[${this.component.tag}] No context options available for render`);
    }

    open(element, context) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Component is already rendered`);
        }

        return RENDER_DRIVERS[context].open.call(this, element);
    }

    renderToParent(element, context, options = {}) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Component is already rendered`);
        }

        if (context && !this.component.contexts[context]) {
            throw new Error(`Invalid context: ${context}`);
        }

        context = context || this.getRenderContext(element);

        if (!this.parentWindow) {
            throw new Error(`[${this.component.tag}] Can not render to parent - no parent exists`);
        }

        if (!window.name) {
            throw new Error(`[${this.component.tag}] Can not render to parent - not in a child component window`);
        }

        RENDER_DRIVERS[context].renderToParent.call(this, element);

        return postRobot.sendToParent(CONSTANTS.POST_MESSAGE.RENDER, {

            ...options,

            tag: this.component.tag,
            context: context,
            element: element,

            options: {
                props: this.props,

                childWindowName: this.childWindowName,
                screenWidth:     this.screenWidth,
                screenHeight:    this.screenHeight
            }

        }).then(data => {

            if (!this.window) {
                this.setForCleanup('window', this.parentWindow.frames[this.childWindowName]);
            }

            this.listen(this.window);
        });
    }

    renderIframe(element) {
        return this.render(element, CONTEXT_TYPES.IFRAME);
    }

    openIframe(element) {
        return this.open(element, CONTEXT_TYPES.IFRAME);
    }

    renderIframeToParent(element) {
        return this.renderToParent(element, CONTEXT_TYPES.IFRAME);
    }

    renderLightbox() {
        return this.render(null, CONTEXT_TYPES.LIGHTBOX);
    }

    openLightbox() {
        return this.open(null, CONTEXT_TYPES.LIGHTBOX);
    }

    renderLightboxToParent() {
        return this.renderToParent(null, CONTEXT_TYPES.LIGHTBOX);
    }

    renderPopup() {
        return this.render(null, CONTEXT_TYPES.POPUP);
    }

    openPopup() {
        return this.open(null, CONTEXT_TYPES.POPUP);
    }

    renderPopupToParent() {
        return this.renderToParent(null, CONTEXT_TYPES.POPUP);
    }




    watchForClose() {

        onCloseWindow(this.window, () => {
            this.props.onClose(new Error(`[${this.component.tag}] ${this.context} was closed`));
            this.destroy();
        });

        window.addEventListener('beforeunload', () => {
            if (this.popup) {
                this.popup.close();
            }
        });
    }

    loadUrl(url) {

        if (this.popup) {
            this.popup.location = url;
        } else if (this.iframe) {
            this.iframe.src = url;
        }
    }

    hijackToPopup(element) {
        return this.hijack(element, CONTEXT_TYPES.POPUP);
    }

    hijackToLightbox(element) {
        return this.hijack(element, CONTEXT_TYPES.LIGHTBOX);
    }

    hijack(element, context = CONTEXT_TYPES.LIGHTBOX) {
        let el = getElement(element);

        if (!el) {
            throw new Error(`[${this.component.tag}] Can not find element: ${element}`);
        }

        let isButton = el.tagName.toLowerCase() === 'button' || (el.tagName.toLowerCase() === 'input' && el.type === 'submit');

        if (isButton) {
            el = getParentNode(el, 'form');
        }

        el.addEventListener('click', event => {

            if (this.window) {
                event.preventDefault();
            }

            this.renderHijack(el, context);
        });

        return this;
    }

    renderHijack(el, context = CONTEXT_TYPES.LIGHTBOX) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Component is already rendered`);
        }

        let driver = RENDER_DRIVERS[context];

        driver.open.call(this);

        el.target = this.childWindowName;

        this.listen(this.window);
        this.runTimeout();

        if (driver.overlay) {
            this.createOverlay();
        }
    }

    submitParentForm() {
        return this.renderToParent(null, CONTEXT_TYPES.POPUP, {
            submitParentForm: true
        });
    }

    runTimeout() {

        if (this.props.timeout) {
            setTimeout(() => {
                if (!this.entered) {
                    this.props.onTimeout.call(this, new Error(`[${this.component.tag}] Loading component ${this.component.tag} at ${this.url} timed out after ${this.props.timeout} milliseconds`));
                    this.destroy();
                }
            }, this.props.timeout);
        }
    }

    listeners() {
        return {
            [ CONSTANTS.POST_MESSAGE.INIT ](source, data) {
                this.props.onEnter.call(this);
                this.entered = true;

                return {
                    context: this.context,
                    props: this.props
                };
            },

            [ CONSTANTS.POST_MESSAGE.CLOSE ](source, data) {
                this.destroy();
            },

            [ CONSTANTS.POST_MESSAGE.RESIZE ](source, data) {

                if (this.context === CONSTANTS.CONTEXT.POPUP) {
                    throw new Error(`[${this.component.tag}] Can not resize popup from parent`);
                }

                return this.resize(data.width, data.height);
            },

            [ CONSTANTS.POST_MESSAGE.RENDER ](source, data) {
                let component = this.component.getByTag(data.tag);
                let instance =  component.parent(data.options);

                if (data.submitParentForm) {
                    let form = getParentNode(this.iframe, 'form');
                    instance.renderHijack(form, data.context);
                    form.submit();

                } else {
                    instance.render(data.element, data.context);
                }
            },

            [ CONSTANTS.POST_MESSAGE.ERROR ](source, data) {
                this.destroy();
                this.props.onError(new Error(data.error));
            }
        };
    }

    close() {
        return postRobot.send(this.window, CONSTANTS.POST_MESSAGE.CLOSE).catch(err => {
            console.warn('Error sending close message to child', err.stack || err.toString());
            this.destroy();
        });
    }

    focus() {
        if (this.popup) {
            this.popup.focus();
        }
        return this;
    }

    resize(height, width) {
        return Promise.resolve().then(() => {

            if (this.context === CONSTANTS.CONTEXT.POPUP) {
                return postRobot.send(this.popup, CONSTANTS.POST_MESSAGE.RESIZE, {
                    height,
                    width
                });

            } else if (this.context === CONSTANTS.CONTEXT.IFRAME) {

                this.iframe.height = height;
                this.iframe.width = width;
            }
        });
    }

    createOverlay() {

        this.overlay = createElement('div', {

            html: this.component.overlayTemplate,

            class: [
                `xcomponent-overlay`,
                `xcomponent-${this.context}`
            ],

            style: { zIndex: MAX_Z_INDEX - 1 },

            events: {
                click: event => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.focus();
                }
            }

        }, document.body);

        this.overlayStyle = createElement('style', {

            styleSheet: this.component.overlayStyle,

            attributes: {
                type: 'text/css'
            }

        }, document.body);

        this.registerForCleanup(() => {
            document.body.removeChild(this.overlay);
            document.body.removeChild(this.overlayStyle);
        });

        Array.prototype.slice.call(this.overlay.getElementsByClassName('xcomponent-close')).forEach(el => {
            el.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            });
        });
    }

    destroy() {
        this.cleanup();
    }

}