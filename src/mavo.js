/**
 * Mavo: Create web applications by writing HTML and CSS!
 * @author Lea Verou and contributors
 * @version %%VERSION%%
 */

 Stretchy.selectors.filter = ".mv-editor:not([property]), .mv-autosize";

(async function ($, $$) {

// Define $ and $$ if they are not already defined
// Primarily for backwards compat since we used to use Bliss Full.
self.$ = self.$ || $;
self.$$ = self.$$ || $$;

var _ = self.Mavo = $.Class({
	constructor: function (element) {
		this.treeBuilt = Mavo.promise();
		this.dataLoaded = Mavo.promise();
		this.deleted = [];

		this.element = element;

		this.inProgress = false;

		// Index among other mavos in the page, 1 is first
		this.index = Object.keys(_.all).length + 1;
		Object.defineProperty(_.all, this.index - 1, {value: this, configurable: true});

		// Convert any data-mv-* attributes to mv-*
		Mavo.attributeStartsWith("data-mv-", this.element).forEach(attribute => {
			var element = attribute.ownerElement;
			var name = attribute.name.replace("data-", "");

			if (!element.attributes[name]) {
				element.setAttribute(name, attribute.value);
			}
		});

		// Assign a unique (for the page) id to this mavo instance
		this.id = Mavo.getAttribute(this.element, "mv-app", "id") || `mavo${this.index}`;

		if (this.id in _.all) {
			// Duplicate app name
			for (var i=2; this.id + i in _.all; i++) {}
			this.id = this.id + i;
		}

		_.all[this.id] = this;
		this.element.setAttribute("mv-app", this.id);

		this.observe({attribute: "lang", deep: false}, () => {
			var lang = Mavo.getClosestAttribute(this.element, "lang") || Mavo.locale;
			this.locale = Mavo.Locale.get(lang);
		})();

		// Should we start in edit mode?
		this.autoEdit = this.element.classList.contains("mv-autoedit");

		// Should we save automatically?
		this.autoSave = this.element.hasAttribute("mv-autosave");
		this.autoSaveDelay = (this.element.getAttribute("mv-autosave") || 0) * 1000;

		Mavo.setAttributeShy(this.element, "typeof", "");

		Mavo.hooks.run("init-start", this);

		// ----- Heuristic for groups ------

		// First, add property attributes to mv-multiple elements without one
		$$(_.selectors.multiple, this.element).forEach(element => {
			_.setAttributeShy(element, "property", "");
		});

		// Now, turn properties that contain other properties into groups
		$$(_.selectors.primitive, this.element).forEach(element => {
			if ($(_.selectors.property, element)) { // contains other properties
				var config = Mavo.Primitive.getConfig(element);

				if (!config.attribute && !config.hasChildren || Mavo.is("multiple", element)) {
					Mavo.setAttributeShy(element, "typeof", "");
				}
			}
		});

		this.expressions = new Mavo.Expressions(this);

		_.observers = _.observers || new Mavo.Observers();
		_.observers.observer.observe(this.element, {
			// Observe everything
			characterData: true,
			childList: true,
			subtree: true,
			attributes: true
		});

		// Build mavo objects
		Mavo.hooks.run("init-tree-before", this);

		this.root = new Mavo.Group(this.element, this);
		this.treeBuilt.resolve();

		Mavo.hooks.run("init-tree-after", this);

		this.permissions = new Mavo.Permissions();

		var backendTypes = ["source", "storage", "init", "uploads"]; // order is significant!

		// Figure out backends for storage, data reads, and initialization respectively
		backendTypes.forEach(role => this.updateBackend(role));

		this.observe({deep: false, attribute: true}, ({attribute}) => {
			if (attribute.indexOf("mv-") === 0) {
				// We want to observe changes both in a backend (the mv-role attribute)
				// and its metadata (provided via the mv-role-* family of attributes)
				let role = attribute?.replace(/^mv-/, "")?.split("-")?.[0];

				if (backendTypes.includes(role)) {
					this.updateBackend(role);

					// Do we need to re-load data?
					if (role === "source" || (!this.source && (role === "storage" || role === "init" && !this.root.data))) {
						this.load();
					}
				}
			}

		});

		this.permissions.can("login", () => {
			// We also support a URL param to trigger login, in case the user doesn't want visible login UI
			let loginUrlParam;
			if (Mavo.Functions.url("login") !== null && this.index === 1) {
				loginUrlParam = "login";
			}
			else if (Mavo.Functions.url(this.id + "-login") !== null) {
				loginUrlParam = this.id + "-login";
			}

			if (loginUrlParam !== undefined) {
				// Remove param from url
				const currentURL = new URL(location.href);
				currentURL.searchParams.delete(loginUrlParam);
				history.replaceState(null, "", currentURL);
				this.primaryBackend.login();
			}
		});

		// Update login status
		$.bind(this.element, "mv-login.mavo", evt => {
			if (evt.backend == (this.source || this.storage)) {
				// If last time we rendered we got nothing, maybe now we'll have better luck?
				if (!this.root.data && !this.unsavedChanges) {
					this.load();
				}
			}
		});

		this.bar = new Mavo.UI.Bar(this);

		// Is there any control that requires an edit button?
		this.needsEdit = this.calculateNeedsEdit();

		this.setUnsavedChanges(false);

		this.permissions.onchange(({action, value}) => {
			var permissions = this.element.getAttribute("mv-permissions") || "";
			permissions = permissions.trim().split(/\s+/).filter(a => a != action);

			if (value) {
				permissions.push(action);
			}

			this.element.setAttribute("mv-permissions", permissions.join(" "));
		});

		this.permissions.can(["edit", "add", "delete"], () => {
			if (this.autoEdit) {
				this.edit();
			}
		});

		// Observe entire tree for mv-mode changes
		this.observe({attribute: "mv-mode"}, ({element}) => {
			if (!this.permissions.edit && !this.permissions.add && !this.permissions.delete) {
				return;
			}

			let nodes = _.Node.children(element);

			nodeloop: for (let i=0; i<nodes.length; i++) {
				let node = nodes[i];
				let previousMode = node.mode, mode;

				if (node.element == element) {
					// If attribute set directly on a Mavo node, then it forces it into that mode
					// otherwise, descendant nodes still inherit, unless they are also mode-restricted
					mode = node.element.getAttribute("mv-mode");
					node.modes = mode;
				}
				else {
					// Inherited
					if (node.modes) {
						// Mode-restricted, we cannot change to the other mode
						continue nodeloop;
					}

					mode = _.getStyle(node.element.parentNode, "--mv-mode");
				}

				node.mode = mode;

				if (previousMode != node.mode) {
					node[node.mode == "edit"? "edit" : "done"]();
				}
			}
		});


		if (this.storage || this.source) {
			// Fetch existing data
			this.permissions.can("read", () => this.load());
		}
		else {
			// No storage or source
			requestAnimationFrame(() => {
				this.dataLoaded.resolve();
				this.expressions.update();
				$.fire(this.element, "mv-load");
			});
		}

		// Dynamic ids
		$.bind(this.element, "mv-load.mavo", evt => {
			if (location.hash) {
				var callback = () => {
					var target = document.getElementById(location.hash.slice(1));

					if (target || !location.hash) {
						if (this.element.contains(target)) {
							requestAnimationFrame(() => { // Give the browser a chance to render
								Mavo.scrollIntoViewIfNeeded(target);
							});
						}
					}

					return target;
				};

				if (!callback()) {
					// No target, perhaps not yet?
					this.observe({attribute: "id", once: true}, callback);
					// FIXME if expressions take multiple cycles to resolve, this will not scroll to the proper id
					// FIXME also, if the user has started interacting with the document, we shouldn't scroll
				}
			}

			requestAnimationFrame(() => Stretchy.resizeAll());
		});


		if (this.autoSave) {
			this.dataLoaded.then(evt => {
				var debouncedSave = _.debounce(() => {
					this.save();
				}, this.autoSaveDelay);

				var callback = evt => {
					if (evt.node.saved && this.autoSave) {
						debouncedSave();
					}
				};

				requestAnimationFrame(() => {
					this.permissions.can("save", () => {
						$.bind(this.element, "mv-change.mavo:autosave", callback);
					}, () => {
						$.unbind(this.element, "mv-change.mavo:autosave", callback);
					});
				});
			});
		}

		// Keyboard navigation
		this.element.addEventListener("keydown", evt => {
			var element = evt.target;

			// Ctrl + S or Cmd + S to save
			if (this.permissions.save && evt.key == "S" && evt[_.superKey] && !evt.altKey) {
				evt.preventDefault();
				this.save();
			}
			else if (evt.key === "ArrowUp" || evt.key === "ArrowDown") {
				if (element.matches("textarea, input[type=range], input[type=number]")) {
					// Up/down arrow keys are meaningful here
					return;
				}

				if (element.matches(".mv-editor")) {
					var editor = true;
					element = element.parentNode;
				}

				var node = Mavo.Node.get(element);

				if (node?.closestCollection) {
					var nextNode = node.getCousin(evt.key === "ArrowUp"? -1 : 1, {wrap: true});

					if (nextNode) {
						if (editor && nextNode.editing) {
							nextNode.edit();
							nextNode.editor.focus();
						}
						else {
							nextNode.element.focus();
						}

						evt.preventDefault();
					}
				}
			}
		});

		$.bind(this.element, "click submit", _.Actions.listener);

		Mavo.hooks.run("init-end", this);
	},

	get editing() {
		return this.root.editing;
	},

	observe (o = {}, callback) {
		let options = Object.assign({element: this.element}, o);
		return _.observers?.observe(options, callback);
	},

	unobserve (o, callback) {
		let options = Object.assign({element: this.element}, o);
		return _.observers?.observe(options, callback);
	},

	getData: function(o) {
		let env = {context: this, options: o};
		env.data = this.root.getData(o);
		_.hooks.run("getdata-end", env);
		return env.data;
	},

	toJSON: function() {
		return _.toJSON(this.getData());
	},

	message: function(message, options = {}) {
		return new _.UI.Message(this, message, options);
	},

	error: function(message, ...log) {
		this.message(message, {
			type: "error",
			dismiss: ["button", "timeout"]
		});

		// Log more info for programmers
		if (log.length > 0) {
			console.log(`%c${this.id}: ${message}`, "color: red; font-weight: bold", ...log);
		}
	},

	render: function(data) {
		var env = {context: this, data};
		_.hooks.run("render-start", env);

		if (env.data) {
			this.root.render(env.data);
		}

		this.unsavedChanges = false;

		_.hooks.run("render-end", env);
	},

	edit: function() {
		this.root.edit();

		// Highlight collection item when item controls are hovered
		$.bind(this.element, "mouseenter.mavo:edit mouseleave.mavo:edit", evt => {
			if (evt.target.matches(_.selectors.multiple)) {
				evt.target.classList.remove("mv-has-hovered-item");

				var parent = evt.target.parentNode.closest(_.selectors.multiple);

				if (parent) {
					parent.classList.toggle("mv-has-hovered-item", evt.type == "mouseenter");
				}
			}
		}, true);

		this.setUnsavedChanges();
	},

	// Conclude editing
	done: function() {
		this.root.done();
		$.unbind(this.element, ".mavo:edit");
		this.unsavedChanges = false;
	},

	/**
	 * Set this mavo instance’s unsavedChanges flag.
	 * @param {Boolean} [value]
	 *        If true, just sets the flag to true, no traversal.
	 *        If false, sets the flag of the Mavo instance and every tree node to false
	 *        If not provided, traverses the tree and recalculates the flag value.
	 */
	setUnsavedChanges: function(value) {
		var unsavedChanges = !!value;

		if (!value) {
			this.walk(obj => {
				if (obj.unsavedChanges) {
					unsavedChanges = true;

					if (value === false) {
						obj.unsavedChanges = false;
					}

					return false;
				}
			});
		}

		return this.unsavedChanges = unsavedChanges;
	},

	/**
	 * Update the backend for a given role
	 * @return {Boolean} true if a change occurred, false otherwise
	 */
	updateBackend (role) {
		let existing = this[role], backend, changed;
		const attribute = "mv-" + role;

		if (this.index == 1) {
			// This app is the first one in the page, so we can override its backend
			// via URL params such as ?storage=...
			backend = _.Functions.url(role);
		}

		if (!backend) {
			backend =  _.Functions.url(`${this.id}-${role}`) || this.element.getAttribute(attribute) || null;
		}

		if (backend) {
			backend = backend.trim();

			if (backend == "none") {
				backend = null;
			}
		}

		if (backend) {
			// Do we have any other attributes?
			let prefix = attribute + "-";
			let roleAttributes = Mavo.getAttributes(this.element, RegExp("^" + prefix));
			let options = Object.fromEntries(roleAttributes.map(n => [n.replace(prefix, ""), this.element.getAttribute(n)]));

			if (!existing?.equals?.(backend)) {
				// We have a string, convert to a backend object if different than existing
				this[role] = backend = _.Backend.create(backend, {
					format: this.element.getAttribute("mv-format"), // can be overwritten by options below
					...options,
					mavo: this
				}, existing);

				changed = true;
			}
		}
		else {
			// We had a backend and now we will un-have it
			this[role] = null;
		}

		changed = changed || (backend? !backend.equals(existing) : Boolean(existing));

		if (changed) {
			// A change occured
			if (!this.storage && !this.source && this.init) {
				// If init is present with no storage and no source, init is equivalent to source
				this.source = this.init;
				this.init = null;
			}

			var permissions = this.storage? this.storage.permissions : new Mavo.Permissions({edit: true, save: false});
			permissions.parent = this.source?.permissions;
			this.permissions.parent = permissions;

			this.primaryBackend = this.storage || this.source;
		}

		return changed;
	},

	/**
	 * load - Fetch data from source and render it.
	 *
	 * @return {Promise}  A promise that resolves when the data is loaded.
	 */
	async load () {
		var backend = this.source || this.storage;

		if (!backend) {
			return;
		}

		this.inProgress = "Loading";

		await backend.ready;

		let data = await backend.load()
		.catch(err => {
			// Try again with init
			if (this.init && this.init != backend) {
				backend = this.init;
				return this.init.ready.then(() => this.init.load());
			}

			// No init, propagate error
			return Promise.reject(err);
		})
		.catch(err => {
			if (err) {
				var xhr = err instanceof XMLHttpRequest? err : err.xhr;

				if (xhr?.status == 404) {
					this.render(null);
				}
				else {
					var message = this._("problem-loading");

					if (xhr) {
						message += xhr.status? this._("http-error", err) : ": " + this._("cant-connect");
					}

					this.error(message, err);
				}
			}
			return null;
		});

		this.render(data);

		this.inProgress = false;

		await Mavo.defer();

		this.dataLoaded.resolve();
		$.fire(this.element, "mv-load");
	},

	async store () {
		if (!this.storage) {
			return;
		}

		this.inProgress = "Saving";

		let saved;

		try {
			saved = await this.storage.store(this.getData());
		}
		catch (err) {
			if (err) {
				var message = this._("problem-saving");

				if (err instanceof XMLHttpRequest) {
					message += ": " + (err.status? this._("http-error", err) : this._("cant-connect"));
				}

				this.error(message, err);
			}

			saved = null;
		}

		this.inProgress = false;
		return saved;
	},

	upload: function(file, path = "images/" + file.name) {
		if (!this.uploadBackend) {
			return Promise.reject();
		}

		this.inProgress = this._("uploading");

		return this.uploadBackend.upload(file, path)
			.then(url => {
				this.inProgress = false;
				return url;
			})
			.catch(err => {
				this.error(this._("error-uploading"), err);
				this.inProgress = false;
				return null;
			});
	},

	async save () {
		_.hooks.run("save-start", this);
		let saved = await this.store();

		if (saved) {
			$.fire(this.element, "mv-save", saved);

			this.lastSaved = Date.now();
			this.root.save();
			this.unsavedChanges = false;
		}
	},

	walk: function() {
		return this.root.walk(...arguments);
	},

	calculateNeedsEdit: function() {
		var needsEdit = false;

		this.walk((obj, path) => {
			if (needsEdit) {
				// If already true, no need to descend further
				return false;
			}

			// True if both modes are allowed and node is not group
			needsEdit = !obj.modes && !(obj instanceof Mavo.Group);

			return !obj.modes;
		}, undefined, {descentReturn: true});

		return needsEdit;
	},

	changed: function(change) {
		if (!this.root) {
			// No tree yet
			return;
		}

		if (this.expressions.active) {
			this.expressions.updateThrottled(change);
		}
	},

	setDeleted: function(...nodes) {
		// Clear previous deleted item(s)
		this.deleted.forEach(node => node.destroy());
		this.deleted.length = [];

		this.deletionNotice?.close();

		if (!nodes.length) {
			return;
		}

		this.deleted.push(...nodes);

		if (nodes.length == 1) {
			var phrase = nodes[0].name;
		}
		else { // Multiple items deleted, possibly from multiple collections
			var counts = {}, ret = [];

			nodes.forEach(n => {
				counts[n.name] = (counts[n.name] || 0) + 1;
			});

			for (var name in counts) {
				ret.push(this._("n-items", {name, n: counts[name]}));
			}

			var phrase = ret.join(", ");
		}

		var notice = this.deletionNotice = this.message(
			[
				this._("item-deleted", {name: phrase}),
				{
					tag: "button",
					type: "button",
					textContent: this._("undo"),
					events: {
						click: evt => {
							this.undoDelete();
							this.deletionNotice.close(true);
						}
					}
				}
			], {
				classes: "mv-deleted",
				dismiss: {
					button: true,
					timeout: 20000
				}
			});

		notice.closed.then(undone => {
			if (!undone && this.deleted.length) {
				// Gone forever now
				this.deleted.forEach(node => node.destroy());
				this.deleted.length = 0;
			}

			if (this.deletionNotice == notice) {
				this.deletionNotice = null;
			}
		});
	},

	undoDelete: function() {
		this.deleted.forEach(node => node.collection.add(node, node.index));
		this.deleted.length = 0;
	},

	// A lot of this is inspired by @hopeful2's work in https://github.com/mavoweb/mavo/pull/430
	destroy () {
		Mavo.hooks.run("mavo-destroy-start", this);

		if (this.editing) {
			this.done();
		}

		// first remove observers.
		this.observer.destroy();

		this.bar?.destroy();

		// .index starts from 1, .all starts from 0
		// ISSUE Should we just delete this and rearrange the other indices?
		Mavo.all[this.id] = Mavo.all[this.index - 1] = null;

		this.root.destroy();

		Mavo.hooks.run("mavo-destroy-end", this);
	},

	live: {
		inProgress: function(value) {
			$.toggleAttribute(this.element, "mv-progress", value, value);
			$.toggleAttribute(this.element, "aria-busy", !!value, !!value);
			this.element.style.setProperty("--mv-progress-text", value? `"${this._(value)}"` : "");
		},

		unsavedChanges: function(value) {
			this.element.classList.toggle("mv-unsaved-changes", value);
		},

		needsEdit: function(value) {
			if (this.bar) {
				this.bar.toggle("edit", value && this.permissions.edit);
			}
		},

		storage: function(value) {
			if (value !== this._storage && !value) {
				var permissions = new Mavo.Permissions({edit: true, save: false});
				permissions.parent = this.permissions.parent;
				this.permissions.parent = permissions;
			}
		},

		primaryBackend: function(value) {
			value = value || null;

			if (value != this._primaryBackend) {
				return value;
			}
		},

		uploadBackend: {
			get: function () {
				const backend = this.uploads;

				if (backend?.upload) {
					// We need to authenticate a user if we haven't done that earlier
					if (backend.permissions.login) {
						backend.login();
					}

					return this.uploads;
				}

				if (this.storage?.upload) {
					// Prioritize storage
					return this.storage;
				}
			}
		}
	},

	static: {
		version: "%%VERSION%%",

		all: {},

		get: function(id) {
			if (id instanceof Element) {
				// Get by element
				for (var name in _.all) {
					if (_.all[name].element == id) {
						return _.all[name];
					}
				}

				return null;
			}

			var name = typeof id === "number"? Object.keys(_.all)[id] : id;

			return _.all[name] || null;
		},

		superKey: navigator.platform.indexOf("Mac") === 0? "metaKey" : "ctrlKey",
		base: location.protocol == "about:"? (document.currentScript? document.currentScript.src : "http://mavo.io") : location,
		dependencies: [
			// Plugins.load() must be run after DOM load to pick up all mv-plugins attributes
			$.ready().then(() => _.Plugins.load()),
		],

		// Only naive tests here (no false positives, but false negatives are ok).
		// polyfill.io will do more proper checking
		polyfillsNeeded: {
			"blissfuljs": Array.from && document.documentElement.closest && self.URL && "searchParams" in URL.prototype,
			"Intl.~locale.en": self.Intl,
			"IntersectionObserver": self.IntersectionObserver,
			"Symbol": self.Symbol,
			"Element.prototype.remove": Element.prototype.remove,
			"Element.prototype.before": Element.prototype.before,
			"Element.prototype.after": Element.prototype.after,
			"Element.prototype.prepend": Element.prototype.prepend,
			"Array.prototype.flat": Array.prototype.flat,
			"Array.prototype.flatMap": Array.prototype.flatMap,
		},
		polyfills: [],

		init: function(container = document) {
			var mavos = Array.isArray(arguments[0])? arguments[0] : $$(_.selectors.init, container);

			var ret = mavos.filter(element => !_.get(element)) // not already inited
				.map(element => new _(element));

			return ret;
		},

		observe (options, callback) {
			_.observers = _.observers || new Mavo.Observers();
			return _.observers.observe(options, callback);
		},

		unobserve (options, callback) {
			_.observers.unobserve(options, callback);
		},

		warn: function warn(message, o = {}) {
			warn.history = warn.history || new Set();

			if (!_.warn.history.has(message)) {
				console.warn(message);
			}

			if (o.once !== false) {
				warn.history.add(message);
			}
		},

		/**
		 * Similar to Promise.all() but can handle post-hoc additions
		 * and does not reject if one promise rejects.
		 */
		thenAll: function(iterable) {
			// Turn rejected promises into resolved ones
			$$(iterable).forEach(promise => {
				if ($.type(promise) == "promise") {
					promise = promise.catch(err => err);
				}
			});

			return Promise.all(iterable).then(resolved => {
				if (iterable.length != resolved.length) {
					// The list of promises or values changed. Return a new Promise.
					// The original promise won't resolve until the new one does.
					return _.thenAll(iterable);
				}

				// The list of promises or values stayed the same.
				// Return results immediately.
				return resolved;
			});
		},

		promise: function(constructor) {
			var res, rej;

			var promise = new Promise((resolve, reject) => {
				if (typeof constructor === "function") {
					constructor(resolve, reject);
				}
				else if (constructor instanceof Promise) {
					constructor.then(resolve);
					constructor.catch(reject);
				}

				res = resolve;
				rej = reject;
			});

			promise.resolve = a => {
				res(a);
				return promise;
			};

			promise.reject = a => {
				rej(a);
				return promise;
			};

			return promise;
		},

		defer: delay => new Promise(resolve => delay === undefined? requestAnimationFrame(resolve) : setTimeout(resolve, delay)),

		UI: {},

		hooks: new $.Hooks(),

		// Will be filled with a union of all properties across all Mavos
		properties: new Set(),

		attributes: [
			"mv-app", "mv-storage", "mv-source", "mv-init", "mv-path", "mv-multiple-path", "mv-format",
			"mv-attribute", "mv-default", "mv-mode", "mv-edit", "mv-editor", "mv-permisssions",
			"mv-rel", "mv-value"
		],

		lazy: {
			locale: () => document.documentElement.lang || "en-GB"
		}
	}
});

// Define symbols
// These are lazy to give the Symbol polyfill a chance to load if needed
["toNode", "isProxy", "route", "parent", "property", "mavo", "groupedBy", "as"].forEach(symbol => {
	$.lazy(_, symbol, () => Symbol(symbol));
});

Object.defineProperty(_.all, "length", {
	get: function() {
		return Object.keys(this).length;
	}
});

{

let s = _.selectors = {
	init: "[mv-app], [data-mv-app]",
	property: "[property]",
	specificProperty: name => `[property=${name}]`,
	group: "[typeof], [mv-group]",
	primitive: "[property]:not([typeof]):not([mv-group])",
	childGroup: "[typeof][property], [mv-group][property]",
	multiple: "[mv-multiple]",
	formControl: "input, select, option, textarea",
	textInput: ["text", "email", "url", "tel", "search", "number"].map(t => `input[type=${t}]`).join(", ") + ", input:not([type]), textarea",
	ui: ".mv-ui",
	container: {
		// "li": "ul, ol",
		"tr": "table",
		"option": "select",
		// "dt": "dl",
		// "dd": "dl"
	}
};

$.extend(_.selectors, {
	item: s.multiple + ", " + s.group,
	output: s.specificProperty("output") + ", .mv-output"
});

}

$.each(_.polyfillsNeeded, (id, supported) => {
	if (!supported) {
		_.polyfills.push(id);
	}
});

_.ready = _.thenAll(_.dependencies);
_.inited = _.promise();

// Init mavo. Async to give other scripts a chance to modify stuff.
await _.defer();

if (_.polyfills.length > 0) {
	var polyfillURL = "https://cdn.polyfill.io/v2/polyfill.min.js?unknown=polyfill&features=" + _.polyfills.map(a => a + "|gated").join(",");
	_.dependencies.push($.include(polyfillURL));
}

await $.ready();

$$(_.selectors.init).forEach(function(elem) {
	// Skip if an instance has been created, for example by another script.
	if (!_.get(elem)) {
		elem.setAttribute("mv-progress", "Loading");
	}
});

await _.ready;

_.init();
_.inited.resolve();

})(Bliss, Bliss.$);
