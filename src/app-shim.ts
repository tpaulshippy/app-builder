/**
 * The `lakebed/client` replacement served to the live app view.
 *
 * The real client talks to a lakebed backend over a WebSocket transport. The
 * app view has no backend — it has the isolate — so this module implements
 * the same hook shapes against two worker endpoints: state is polled (and
 * refreshed after every write), writes POST one round trip and return fresh
 * query results. `undefined`-until-first-result, throw-on-error, and
 * positional mutation args all match the real hooks.
 *
 * Served verbatim as ESM (no sucrase pass), so this file is plain JavaScript
 * inside the template string: no TypeScript syntax, no backticks, no `${`.
 * Preact comes from the same esm.sh files the app bundle uses — two copies
 * break hooks state.
 *
 * Faithful where the isolate can serve it (queries, mutations, actions,
 * router, error boundary); explicit where it cannot (auth is a guest,
 * storage and sign-in throw a plain error naming the deployed backend).
 */

import { PREACT_HOOKS_PIN, PREACT_PIN } from "./lakebed";

export const APP_SHIM_JS = `import { h, Component, createContext, toChildArray } from "${PREACT_PIN}";
import { useState, useEffect, useLayoutEffect, useCallback, useContext } from "${PREACT_HOOKS_PIN}";

var boot = (typeof window !== "undefined" && window.__APP_BOOT__) || {};
var SID = boot.sid || "";
var API = boot.api || {};
var seed = boot.state || null;
var lastError = boot.error ? new Error(boot.error.message || "app failed to start") : null;

var listeners = new Set();
function notify() {
  listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
}

var pollTimer = null;
function ensurePoll() {
  if (pollTimer || typeof window === "undefined" || typeof document === "undefined") return;
  pollTimer = setInterval(function () {
    if (document.visibilityState === "visible") refresh();
  }, 2500);
}

async function refresh() {
  try {
    var res = await fetch(API.state + "?sid=" + encodeURIComponent(SID), { headers: { accept: "application/json" } });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body.ok) throw new Error((body && body.error && body.error.message) || ("app state request failed: " + res.status));
    seed = { tables: body.tables, queries: body.queries };
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e : new Error(String(e));
  }
  notify();
}

async function callKind(kind, name, args) {
  var res = await fetch(API.mutate, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sid: SID, kind: kind, name: name, args: args }),
  });
  var body = await res.json().catch(function () { return {}; });
  if (!res.ok || !body.ok) {
    throw new Error((body && body.error && body.error.message) || ("app " + kind + " failed: " + res.status));
  }
  seed = { tables: body.tables, queries: body.queries };
  lastError = null;
  notify();
  return body.result === undefined ? null : body.result;
}

function useQueryValue(name, args) {
  var key = name + ":" + JSON.stringify(args);
  var force = useState(0)[1];
  useLayoutEffect(function () {
    var fn = function () { force(function (n) { return n + 1; }); };
    listeners.add(fn);
    ensurePoll();
    if (!seed || !seed.queries || !(name in seed.queries)) refresh();
    return function () { listeners.delete(fn); };
  }, [key]);
  if (lastError) throw lastError;
  return seed && seed.queries ? seed.queries[name] : undefined;
}

function useMutationFn(name) {
  return useCallback(function () {
    var args = Array.prototype.slice.call(arguments);
    return callKind("mutation", name, args);
  }, [name]);
}

function useActionFn(name) {
  return useCallback(function () {
    var args = Array.prototype.slice.call(arguments);
    return callKind("action", name, args);
  }, [name]);
}

function isPageResult(v) {
  return Boolean(v) && typeof v === "object" && Array.isArray(v.page) && typeof v.isDone === "boolean";
}

// Approximation: the isolate has no cursor transport, so only the first page
// exists. Non-page query results are wrapped so list code keeps working.
function usePaginatedQueryFn(name, args, _options) {
  var value = useQueryValue(name, args);
  if (value === undefined) {
    return { results: [], isDone: true, continueCursor: null, loadMore: function () {}, reset: function () { refresh(); } };
  }
  var page = isPageResult(value) ? value : null;
  return {
    results: page ? page.page : (Array.isArray(value) ? value : [value]),
    isDone: page ? page.isDone : true,
    continueCursor: (page && page.continueCursor) || null,
    loadMore: function () {},
    reset: function () { refresh(); },
  };
}

export function createClient(_options) {
  return {
    useQuery: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      return useQueryValue(name, args);
    },
    useMutation: function (name) { return useMutationFn(name); },
    useAction: function (name) { return useActionFn(name); },
    usePaginatedQuery: function (name, args, options) { return usePaginatedQueryFn(name, args, options); },
    storage: storage,
  };
}
export function useQuery(name) {
  var args = Array.prototype.slice.call(arguments, 1);
  return useQueryValue(name, args);
}
export function useMutation(name) { return useMutationFn(name); }
export function useAction(name) { return useActionFn(name); }
export function usePaginatedQuery(name, args, options) { return usePaginatedQueryFn(name, args, options); }

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error: error }; }
  render(props, state) {
    var self = this;
    if (state.error) {
      if (props.fallback) {
        return props.fallback(state.error, function () { self.setState({ error: null }); });
      }
      var friendly = describeError(state.error);
      return h("main", { style: "font-family: sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem" },
        h("h1", null, friendly.title),
        h("p", { style: "color: #c9ced1" }, friendly.body),
        h("pre", { style: "white-space: pre-wrap; overflow-wrap: anywhere; color: #7d8285; font-size: 12px" },
          String((state.error && state.error.message) || state.error)),
        h("button", { type: "button", onClick: function () {
          lastError = null;
          refresh();
          self.setState({ error: null });
        } }, "Retry"));
    }
    return props.children;
  }
}

// Native-bridge failures (injected blockers, wallets, in-app browsers) arrive
// with WebKit's own wording and no actionable detail. Say what happened and
// what to do instead of echoing the raw text alone.
function describeError(error) {
  var msg = String((error && error.message) || error);
  if (/WKWebView|webkit.+messageHandlers|did not respond to .+postMessage/i.test(msg)) {
    return {
      title: "A content blocker or browser extension broke the app's connection",
      body: "Something installed in this browser (a content blocker, ad blocker, password manager, " +
        "or an in-app browser) intercepted the app's requests and failed. Turn it off for this site — " +
        "on iPhone: Settings, then Safari (or Apps, then Safari), then Extensions and Content Blockers — " +
        "reload the page, and press Retry.",
    };
  }
  return { title: "Something broke", body: "" };
}

var RouterContext = createContext(null);
var RouteContext = createContext({ params: {} });

function currentLocation() {
  return {
    pathname: window.location.pathname || "/",
    search: window.location.search || "",
    hash: window.location.hash || "",
  };
}

export function navigate(to, options) {
  options = options || {};
  var url = new URL(String(to === undefined || to === null ? "/" : to), window.location.href);
  var next = url.pathname + url.search + url.hash;
  var cur = window.location.pathname + window.location.search + window.location.hash;
  if (next === cur) return;
  if (options.replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
  window.dispatchEvent(new Event("lakebed:locationchange"));
}

function useBrowserLocation() {
  var loc = useState(currentLocation);
  var setLoc = loc[1];
  useEffect(function () {
    var update = function () {
      var next = currentLocation();
      setLoc(function (cur) {
        return cur.pathname === next.pathname && cur.search === next.search && cur.hash === next.hash ? cur : next;
      });
    };
    window.addEventListener("popstate", update);
    window.addEventListener("lakebed:locationchange", update);
    update();
    return function () {
      window.removeEventListener("popstate", update);
      window.removeEventListener("lakebed:locationchange", update);
    };
  }, []);
  return loc[0];
}

export function Router(props) {
  var location = useBrowserLocation();
  return h(RouterContext.Provider, { value: { location: location, navigate: navigate } }, props.children);
}

function matchPath(pattern, pathname) {
  var norm = function (p) {
    var v = String(p === undefined || p === null ? "/" : p).trim();
    if (v === "*" || v === "/*") return "*";
    var s = v.charAt(0) === "/" ? v : "/" + v;
    return s.length > 1 ? s.replace(/\\/+$/, "") : "/";
  };
  var pat = norm(pattern);
  if (pat === "*") return { params: {} };
  var segs = function (p) { return p === "/" ? [] : p.replace(/^\\/+|\\/+$/g, "").split("/"); };
  var a = segs(pat);
  var b = segs(norm(pathname));
  var params = {};
  for (var i = 0; i < a.length; i++) {
    if (a[i] === "*") { params["*"] = b.slice(i).join("/"); return { params: params }; }
    if (b[i] === undefined) return null;
    if (a[i].charAt(0) === ":") {
      var n = a[i].slice(1);
      if (!n) return null;
      try { params[n] = decodeURIComponent(b[i]); } catch (e) { params[n] = b[i]; }
      continue;
    }
    if (a[i] !== b[i]) return null;
  }
  return a.length === b.length ? { params: params } : null;
}

function collectRoutes(children) {
  var out = [];
  toChildArray(children || []).forEach(function (child) {
    if (!child || typeof child !== "object") return;
    if (child.props && child.props.path !== undefined) out.push(child);
    else if (child.props && child.props.children !== undefined) {
      out.push.apply(out, collectRoutes(child.props.children));
    }
  });
  return out;
}

export function Routes(props) {
  var location = useLocation();
  var routes = collectRoutes(props.children);
  for (var i = 0; i < routes.length; i++) {
    var m = matchPath(routes[i].props.path, location.pathname);
    if (m) return h(RouteContext.Provider, { value: m }, routes[i].props.element || null);
  }
  return null;
}

export function Route(_props) { return null; }

export function Link(props) {
  props = props || {};
  var location = useLocation();
  var to = String(props.to === undefined || props.to === null ? "" : props.to);
  var href;
  if (/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(to) || to.slice(0, 2) === "//") href = to;
  else if (to === "") href = location.pathname + location.search + location.hash;
  else {
    var u = new URL(to, "http://lakebed.local" + location.pathname + location.search);
    href = u.pathname + u.search + u.hash;
  }
  var onClick = function (event) {
    if (props.onClick) props.onClick(event);
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (props.target && props.target !== "_self") return;
    if (/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(href) || href.slice(0, 2) === "//") return;
    event.preventDefault();
    navigate(href);
  };
  var anchorProps = {};
  for (var k in props) {
    if (k === "to" || k === "replace" || k === "onClick" || k === "children") continue;
    anchorProps[k] = props[k];
  }
  anchorProps.href = href;
  anchorProps.onClick = onClick;
  return h("a", anchorProps, props.children);
}

export function useLocation() {
  var context = useContext(RouterContext);
  var fallback = useBrowserLocation();
  return (context && context.location) || fallback;
}

export function useNavigate() {
  var context = useContext(RouterContext);
  return (context && context.navigate) || navigate;
}

export function useParams() {
  return useContext(RouteContext).params;
}

// No deployed backend in the app view, so identity is the same guest the
// isolate's server stub authenticates. Anything needing real auth throws
// plainly when called instead of failing at import time.
var GUEST = { id: "guest", provider: "guest", isGuest: true };

function needBackend(name) {
  return function () {
    throw new Error(name + " needs a deployed lakebed backend and is not available in the app view");
  };
}

export function useAuth() { return { user: GUEST, isSignedIn: false }; }
export function SignInWithGoogle() {
  return h("button", { type: "button", disabled: true }, "Sign in (needs a deployed app)");
}
export var signInWithGoogle = needBackend("signInWithGoogle");
export var signOut = needBackend("signOut");
export var retryAuth = needBackend("retryAuth");
export var getIdentity = async function () { return GUEST; };
export var decodeIdentityClaims = needBackend("decodeIdentityClaims");
export var canAccessApp = function () { return true; };
export var storage = new Proxy({}, {
  get: function (_t, prop) {
    throw new Error("storage." + String(prop) + " needs a deployed lakebed backend and is not available in the app view");
  },
});
`;
