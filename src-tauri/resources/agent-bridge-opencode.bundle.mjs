// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js
var createSseClient = ({ onSseError, onSseEvent, responseTransformer, responseValidator, sseDefaultRetryDelay, sseMaxRetryAttempts, sseMaxRetryDelay, sseSleepFn, url, ...options }) => {
  let lastEventId;
  const sleep = sseSleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createStream = async function* () {
    let retryDelay = sseDefaultRetryDelay ?? 3e3;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;
    while (true) {
      if (signal.aborted)
        break;
      attempt++;
      const headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
      if (lastEventId !== void 0) {
        headers.set("Last-Event-ID", lastEventId);
      }
      try {
        const response = await fetch(url, { ...options, headers, signal });
        if (!response.ok)
          throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
        if (!response.body)
          throw new Error("No body in SSE response");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {
          }
        };
        signal.addEventListener("abort", abortHandler);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done)
              break;
            buffer += value;
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const lines = chunk.split("\n");
              const dataLines = [];
              let eventName;
              for (const line of lines) {
                if (line.startsWith("data:")) {
                  dataLines.push(line.replace(/^data:\s*/, ""));
                } else if (line.startsWith("event:")) {
                  eventName = line.replace(/^event:\s*/, "");
                } else if (line.startsWith("id:")) {
                  lastEventId = line.replace(/^id:\s*/, "");
                } else if (line.startsWith("retry:")) {
                  const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10);
                  if (!Number.isNaN(parsed)) {
                    retryDelay = parsed;
                  }
                }
              }
              let data;
              let parsedJson = false;
              if (dataLines.length) {
                const rawData = dataLines.join("\n");
                try {
                  data = JSON.parse(rawData);
                  parsedJson = true;
                } catch {
                  data = rawData;
                }
              }
              if (parsedJson) {
                if (responseValidator) {
                  await responseValidator(data);
                }
                if (responseTransformer) {
                  data = await responseTransformer(data);
                }
              }
              onSseEvent?.({
                data,
                event: eventName,
                id: lastEventId,
                retry: retryDelay
              });
              if (dataLines.length) {
                yield data;
              }
            }
          }
        } finally {
          signal.removeEventListener("abort", abortHandler);
          reader.releaseLock();
        }
        break;
      } catch (error) {
        onSseError?.(error);
        if (sseMaxRetryAttempts !== void 0 && attempt >= sseMaxRetryAttempts) {
          break;
        }
        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), sseMaxRetryDelay ?? 3e4);
        await sleep(backoff);
      }
    }
  };
  const stream = createStream();
  return { stream };
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/core/auth.gen.js
var getAuthToken = async (auth, callback) => {
  const token = typeof callback === "function" ? await callback(auth) : callback;
  if (!token) {
    return;
  }
  if (auth.scheme === "bearer") {
    return `Bearer ${token}`;
  }
  if (auth.scheme === "basic") {
    return `Basic ${btoa(token)}`;
  }
  return token;
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/core/bodySerializer.gen.js
var jsonBodySerializer = {
  bodySerializer: (body) => JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value)
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/core/pathSerializer.gen.js
var separatorArrayExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var separatorArrayNoExplode = (style) => {
  switch (style) {
    case "form":
      return ",";
    case "pipeDelimited":
      return "|";
    case "spaceDelimited":
      return "%20";
    default:
      return ",";
  }
};
var separatorObjectExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var serializeArrayParam = ({ allowReserved, explode, name, style, value }) => {
  if (!explode) {
    const joinedValues2 = (allowReserved ? value : value.map((v) => encodeURIComponent(v))).join(separatorArrayNoExplode(style));
    switch (style) {
      case "label":
        return `.${joinedValues2}`;
      case "matrix":
        return `;${name}=${joinedValues2}`;
      case "simple":
        return joinedValues2;
      default:
        return `${name}=${joinedValues2}`;
    }
  }
  const separator = separatorArrayExplode(style);
  const joinedValues = value.map((v) => {
    if (style === "label" || style === "simple") {
      return allowReserved ? v : encodeURIComponent(v);
    }
    return serializePrimitiveParam({
      allowReserved,
      name,
      value: v
    });
  }).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};
var serializePrimitiveParam = ({ allowReserved, name, value }) => {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error("Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these.");
  }
  return `${name}=${allowReserved ? value : encodeURIComponent(value)}`;
};
var serializeObjectParam = ({ allowReserved, explode, name, style, value, valueOnly }) => {
  if (value instanceof Date) {
    return valueOnly ? value.toISOString() : `${name}=${value.toISOString()}`;
  }
  if (style !== "deepObject" && !explode) {
    let values = [];
    Object.entries(value).forEach(([key, v]) => {
      values = [...values, key, allowReserved ? v : encodeURIComponent(v)];
    });
    const joinedValues2 = values.join(",");
    switch (style) {
      case "form":
        return `${name}=${joinedValues2}`;
      case "label":
        return `.${joinedValues2}`;
      case "matrix":
        return `;${name}=${joinedValues2}`;
      default:
        return joinedValues2;
    }
  }
  const separator = separatorObjectExplode(style);
  const joinedValues = Object.entries(value).map(([key, v]) => serializePrimitiveParam({
    allowReserved,
    name: style === "deepObject" ? `${name}[${key}]` : key,
    value: v
  })).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/core/utils.gen.js
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var defaultPathSerializer = ({ path, url: _url }) => {
  let url = _url;
  const matches = _url.match(PATH_PARAM_RE);
  if (matches) {
    for (const match of matches) {
      let explode = false;
      let name = match.substring(1, match.length - 1);
      let style = "simple";
      if (name.endsWith("*")) {
        explode = true;
        name = name.substring(0, name.length - 1);
      }
      if (name.startsWith(".")) {
        name = name.substring(1);
        style = "label";
      } else if (name.startsWith(";")) {
        name = name.substring(1);
        style = "matrix";
      }
      const value = path[name];
      if (value === void 0 || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        url = url.replace(match, serializeArrayParam({ explode, name, style, value }));
        continue;
      }
      if (typeof value === "object") {
        url = url.replace(match, serializeObjectParam({
          explode,
          name,
          style,
          value,
          valueOnly: true
        }));
        continue;
      }
      if (style === "matrix") {
        url = url.replace(match, `;${serializePrimitiveParam({
          name,
          value
        })}`);
        continue;
      }
      const replaceValue = encodeURIComponent(style === "label" ? `.${value}` : value);
      url = url.replace(match, replaceValue);
    }
  }
  return url;
};
var getUrl = ({ baseUrl, path, query, querySerializer, url: _url }) => {
  const pathUrl = _url.startsWith("/") ? _url : `/${_url}`;
  let url = (baseUrl ?? "") + pathUrl;
  if (path) {
    url = defaultPathSerializer({ path, url });
  }
  let search = query ? querySerializer(query) : "";
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    url += `?${search}`;
  }
  return url;
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/client/utils.gen.js
var createQuerySerializer = ({ allowReserved, array, object } = {}) => {
  const querySerializer = (queryParams) => {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === void 0 || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          const serializedArray = serializeArrayParam({
            allowReserved,
            explode: true,
            name,
            style: "form",
            value,
            ...array
          });
          if (serializedArray)
            search.push(serializedArray);
        } else if (typeof value === "object") {
          const serializedObject = serializeObjectParam({
            allowReserved,
            explode: true,
            name,
            style: "deepObject",
            value,
            ...object
          });
          if (serializedObject)
            search.push(serializedObject);
        } else {
          const serializedPrimitive = serializePrimitiveParam({
            allowReserved,
            name,
            value
          });
          if (serializedPrimitive)
            search.push(serializedPrimitive);
        }
      }
    }
    return search.join("&");
  };
  return querySerializer;
};
var getParseAs = (contentType) => {
  if (!contentType) {
    return "stream";
  }
  const cleanContent = contentType.split(";")[0]?.trim();
  if (!cleanContent) {
    return;
  }
  if (cleanContent.startsWith("application/json") || cleanContent.endsWith("+json")) {
    return "json";
  }
  if (cleanContent === "multipart/form-data") {
    return "formData";
  }
  if (["application/", "audio/", "image/", "video/"].some((type) => cleanContent.startsWith(type))) {
    return "blob";
  }
  if (cleanContent.startsWith("text/")) {
    return "text";
  }
  return;
};
var checkForExistence = (options, name) => {
  if (!name) {
    return false;
  }
  if (options.headers.has(name) || options.query?.[name] || options.headers.get("Cookie")?.includes(`${name}=`)) {
    return true;
  }
  return false;
};
var setAuthParams = async ({ security, ...options }) => {
  for (const auth of security) {
    if (checkForExistence(options, auth.name)) {
      continue;
    }
    const token = await getAuthToken(auth, options.auth);
    if (!token) {
      continue;
    }
    const name = auth.name ?? "Authorization";
    switch (auth.in) {
      case "query":
        if (!options.query) {
          options.query = {};
        }
        options.query[name] = token;
        break;
      case "cookie":
        options.headers.append("Cookie", `${name}=${token}`);
        break;
      case "header":
      default:
        options.headers.set(name, token);
        break;
    }
  }
};
var buildUrl = (options) => getUrl({
  baseUrl: options.baseUrl,
  path: options.path,
  query: options.query,
  querySerializer: typeof options.querySerializer === "function" ? options.querySerializer : createQuerySerializer(options.querySerializer),
  url: options.url
});
var mergeConfigs = (a, b) => {
  const config2 = { ...a, ...b };
  if (config2.baseUrl?.endsWith("/")) {
    config2.baseUrl = config2.baseUrl.substring(0, config2.baseUrl.length - 1);
  }
  config2.headers = mergeHeaders(a.headers, b.headers);
  return config2;
};
var mergeHeaders = (...headers) => {
  const mergedHeaders = new Headers();
  for (const header of headers) {
    if (!header || typeof header !== "object") {
      continue;
    }
    const iterator = header instanceof Headers ? header.entries() : Object.entries(header);
    for (const [key, value] of iterator) {
      if (value === null) {
        mergedHeaders.delete(key);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          mergedHeaders.append(key, v);
        }
      } else if (value !== void 0) {
        mergedHeaders.set(key, typeof value === "object" ? JSON.stringify(value) : value);
      }
    }
  }
  return mergedHeaders;
};
var Interceptors = class {
  _fns;
  constructor() {
    this._fns = [];
  }
  clear() {
    this._fns = [];
  }
  getInterceptorIndex(id) {
    if (typeof id === "number") {
      return this._fns[id] ? id : -1;
    } else {
      return this._fns.indexOf(id);
    }
  }
  exists(id) {
    const index = this.getInterceptorIndex(id);
    return !!this._fns[index];
  }
  eject(id) {
    const index = this.getInterceptorIndex(id);
    if (this._fns[index]) {
      this._fns[index] = null;
    }
  }
  update(id, fn) {
    const index = this.getInterceptorIndex(id);
    if (this._fns[index]) {
      this._fns[index] = fn;
      return id;
    } else {
      return false;
    }
  }
  use(fn) {
    this._fns = [...this._fns, fn];
    return this._fns.length - 1;
  }
};
var createInterceptors = () => ({
  error: new Interceptors(),
  request: new Interceptors(),
  response: new Interceptors()
});
var defaultQuerySerializer = createQuerySerializer({
  allowReserved: false,
  array: {
    explode: true,
    style: "form"
  },
  object: {
    explode: true,
    style: "deepObject"
  }
});
var defaultHeaders = {
  "Content-Type": "application/json"
};
var createConfig = (override = {}) => ({
  ...jsonBodySerializer,
  headers: defaultHeaders,
  parseAs: "auto",
  querySerializer: defaultQuerySerializer,
  ...override
});

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/client/client.gen.js
var createClient = (config2 = {}) => {
  let _config = mergeConfigs(createConfig(), config2);
  const getConfig = () => ({ ..._config });
  const setConfig = (config3) => {
    _config = mergeConfigs(_config, config3);
    return getConfig();
  };
  const interceptors = createInterceptors();
  const beforeRequest = async (options) => {
    const opts = {
      ..._config,
      ...options,
      fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
      headers: mergeHeaders(_config.headers, options.headers),
      serializedBody: void 0
    };
    if (opts.security) {
      await setAuthParams({
        ...opts,
        security: opts.security
      });
    }
    if (opts.requestValidator) {
      await opts.requestValidator(opts);
    }
    if (opts.body && opts.bodySerializer) {
      opts.serializedBody = opts.bodySerializer(opts.body);
    }
    if (opts.serializedBody === void 0 || opts.serializedBody === "") {
      opts.headers.delete("Content-Type");
    }
    const url = buildUrl(opts);
    return { opts, url };
  };
  const request = async (options) => {
    const { opts, url } = await beforeRequest(options);
    const requestInit = {
      redirect: "follow",
      ...opts,
      body: opts.serializedBody
    };
    let request2 = new Request(url, requestInit);
    for (const fn of interceptors.request._fns) {
      if (fn) {
        request2 = await fn(request2, opts);
      }
    }
    const _fetch = opts.fetch;
    let response = await _fetch(request2);
    for (const fn of interceptors.response._fns) {
      if (fn) {
        response = await fn(response, request2, opts);
      }
    }
    const result = {
      request: request2,
      response
    };
    if (response.ok) {
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        return opts.responseStyle === "data" ? {} : {
          data: {},
          ...result
        };
      }
      const parseAs = (opts.parseAs === "auto" ? getParseAs(response.headers.get("Content-Type")) : opts.parseAs) ?? "json";
      let data;
      switch (parseAs) {
        case "arrayBuffer":
        case "blob":
        case "formData":
        case "json":
        case "text":
          data = await response[parseAs]();
          break;
        case "stream":
          return opts.responseStyle === "data" ? response.body : {
            data: response.body,
            ...result
          };
      }
      if (parseAs === "json") {
        if (opts.responseValidator) {
          await opts.responseValidator(data);
        }
        if (opts.responseTransformer) {
          data = await opts.responseTransformer(data);
        }
      }
      return opts.responseStyle === "data" ? data : {
        data,
        ...result
      };
    }
    const textError = await response.text();
    let jsonError;
    try {
      jsonError = JSON.parse(textError);
    } catch {
    }
    const error = jsonError ?? textError;
    let finalError = error;
    for (const fn of interceptors.error._fns) {
      if (fn) {
        finalError = await fn(error, response, request2, opts);
      }
    }
    finalError = finalError || {};
    if (opts.throwOnError) {
      throw finalError;
    }
    return opts.responseStyle === "data" ? void 0 : {
      error: finalError,
      ...result
    };
  };
  const makeMethod = (method) => {
    const fn = (options) => request({ ...options, method });
    fn.sse = async (options) => {
      const { opts, url } = await beforeRequest(options);
      return createSseClient({
        ...opts,
        body: opts.body,
        headers: opts.headers,
        method,
        url
      });
    };
    return fn;
  };
  return {
    buildUrl,
    connect: makeMethod("CONNECT"),
    delete: makeMethod("DELETE"),
    get: makeMethod("GET"),
    getConfig,
    head: makeMethod("HEAD"),
    interceptors,
    options: makeMethod("OPTIONS"),
    patch: makeMethod("PATCH"),
    post: makeMethod("POST"),
    put: makeMethod("PUT"),
    request,
    setConfig,
    trace: makeMethod("TRACE")
  };
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/core/params.gen.js
var extraPrefixesMap = {
  $body_: "body",
  $headers_: "headers",
  $path_: "path",
  $query_: "query"
};
var extraPrefixes = Object.entries(extraPrefixesMap);

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/client.gen.js
var client = createClient(createConfig({
  baseUrl: "http://localhost:4096"
}));

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.js
var _HeyApiClient = class {
  _client = client;
  constructor(args) {
    if (args?.client) {
      this._client = args.client;
    }
  }
};
var Global = class extends _HeyApiClient {
  /**
   * Get events
   */
  event(options) {
    return (options?.client ?? this._client).get.sse({
      url: "/global/event",
      ...options
    });
  }
};
var Project = class extends _HeyApiClient {
  /**
   * List all projects
   */
  list(options) {
    return (options?.client ?? this._client).get({
      url: "/project",
      ...options
    });
  }
  /**
   * Get the current project
   */
  current(options) {
    return (options?.client ?? this._client).get({
      url: "/project/current",
      ...options
    });
  }
};
var Pty = class extends _HeyApiClient {
  /**
   * List all PTY sessions
   */
  list(options) {
    return (options?.client ?? this._client).get({
      url: "/pty",
      ...options
    });
  }
  /**
   * Create a new PTY session
   */
  create(options) {
    return (options?.client ?? this._client).post({
      url: "/pty",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * Remove a PTY session
   */
  remove(options) {
    return (options.client ?? this._client).delete({
      url: "/pty/{id}",
      ...options
    });
  }
  /**
   * Get PTY session info
   */
  get(options) {
    return (options.client ?? this._client).get({
      url: "/pty/{id}",
      ...options
    });
  }
  /**
   * Update PTY session
   */
  update(options) {
    return (options.client ?? this._client).put({
      url: "/pty/{id}",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Connect to a PTY session
   */
  connect(options) {
    return (options.client ?? this._client).get({
      url: "/pty/{id}/connect",
      ...options
    });
  }
};
var Config = class extends _HeyApiClient {
  /**
   * Get config info
   */
  get(options) {
    return (options?.client ?? this._client).get({
      url: "/config",
      ...options
    });
  }
  /**
   * Update config
   */
  update(options) {
    return (options?.client ?? this._client).patch({
      url: "/config",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * List all providers
   */
  providers(options) {
    return (options?.client ?? this._client).get({
      url: "/config/providers",
      ...options
    });
  }
};
var Tool = class extends _HeyApiClient {
  /**
   * List all tool IDs (including built-in and dynamically registered)
   */
  ids(options) {
    return (options?.client ?? this._client).get({
      url: "/experimental/tool/ids",
      ...options
    });
  }
  /**
   * List tools with JSON schema parameters for a provider/model
   */
  list(options) {
    return (options.client ?? this._client).get({
      url: "/experimental/tool",
      ...options
    });
  }
};
var Instance = class extends _HeyApiClient {
  /**
   * Dispose the current instance
   */
  dispose(options) {
    return (options?.client ?? this._client).post({
      url: "/instance/dispose",
      ...options
    });
  }
};
var Path = class extends _HeyApiClient {
  /**
   * Get the current path
   */
  get(options) {
    return (options?.client ?? this._client).get({
      url: "/path",
      ...options
    });
  }
};
var Vcs = class extends _HeyApiClient {
  /**
   * Get VCS info for the current instance
   */
  get(options) {
    return (options?.client ?? this._client).get({
      url: "/vcs",
      ...options
    });
  }
};
var Session = class extends _HeyApiClient {
  /**
   * List all sessions
   */
  list(options) {
    return (options?.client ?? this._client).get({
      url: "/session",
      ...options
    });
  }
  /**
   * Create a new session
   */
  create(options) {
    return (options?.client ?? this._client).post({
      url: "/session",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * Get session status
   */
  status(options) {
    return (options?.client ?? this._client).get({
      url: "/session/status",
      ...options
    });
  }
  /**
   * Delete a session and all its data
   */
  delete(options) {
    return (options.client ?? this._client).delete({
      url: "/session/{id}",
      ...options
    });
  }
  /**
   * Get session
   */
  get(options) {
    return (options.client ?? this._client).get({
      url: "/session/{id}",
      ...options
    });
  }
  /**
   * Update session properties
   */
  update(options) {
    return (options.client ?? this._client).patch({
      url: "/session/{id}",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Get a session's children
   */
  children(options) {
    return (options.client ?? this._client).get({
      url: "/session/{id}/children",
      ...options
    });
  }
  /**
   * Get the todo list for a session
   */
  todo(options) {
    return (options.client ?? this._client).get({
      url: "/session/{id}/todo",
      ...options
    });
  }
  /**
   * Analyze the app and create an AGENTS.md file
   */
  init(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/init",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Fork an existing session at a specific message
   */
  fork(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/fork",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Abort a session
   */
  abort(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/abort",
      ...options
    });
  }
  /**
   * Unshare the session
   */
  unshare(options) {
    return (options.client ?? this._client).delete({
      url: "/session/{id}/share",
      ...options
    });
  }
  /**
   * Share a session
   */
  share(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/share",
      ...options
    });
  }
  /**
   * Get the diff for this session
   */
  diff(options) {
    return (options.client ?? this._client).get({
      url: "/session/{id}/diff",
      ...options
    });
  }
  /**
   * Summarize the session
   */
  summarize(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/summarize",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * List messages for a session
   */
  messages(options) {
    return (options.client ?? this._client).get({
      url: "/session/{id}/message",
      ...options
    });
  }
  /**
   * Create and send a new message to a session
   */
  prompt(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/message",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Get a message from a session
   */
  message(options) {
    return (options.client ?? this._client).get({
      url: "/session/{id}/message/{messageID}",
      ...options
    });
  }
  /**
   * Create and send a new message to a session, start if needed and return immediately
   */
  promptAsync(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/prompt_async",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Send a new command to a session
   */
  command(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/command",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Run a shell command
   */
  shell(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/shell",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Revert a message
   */
  revert(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/revert",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Restore all reverted messages
   */
  unrevert(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/unrevert",
      ...options
    });
  }
};
var Command = class extends _HeyApiClient {
  /**
   * List all commands
   */
  list(options) {
    return (options?.client ?? this._client).get({
      url: "/command",
      ...options
    });
  }
};
var Oauth = class extends _HeyApiClient {
  /**
   * Authorize a provider using OAuth
   */
  authorize(options) {
    return (options.client ?? this._client).post({
      url: "/provider/{id}/oauth/authorize",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Handle OAuth callback for a provider
   */
  callback(options) {
    return (options.client ?? this._client).post({
      url: "/provider/{id}/oauth/callback",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
};
var Provider = class extends _HeyApiClient {
  /**
   * List all providers
   */
  list(options) {
    return (options?.client ?? this._client).get({
      url: "/provider",
      ...options
    });
  }
  /**
   * Get provider authentication methods
   */
  auth(options) {
    return (options?.client ?? this._client).get({
      url: "/provider/auth",
      ...options
    });
  }
  oauth = new Oauth({ client: this._client });
};
var Find = class extends _HeyApiClient {
  /**
   * Find text in files
   */
  text(options) {
    return (options.client ?? this._client).get({
      url: "/find",
      ...options
    });
  }
  /**
   * Find files
   */
  files(options) {
    return (options.client ?? this._client).get({
      url: "/find/file",
      ...options
    });
  }
  /**
   * Find workspace symbols
   */
  symbols(options) {
    return (options.client ?? this._client).get({
      url: "/find/symbol",
      ...options
    });
  }
};
var File = class extends _HeyApiClient {
  /**
   * List files and directories
   */
  list(options) {
    return (options.client ?? this._client).get({
      url: "/file",
      ...options
    });
  }
  /**
   * Read a file
   */
  read(options) {
    return (options.client ?? this._client).get({
      url: "/file/content",
      ...options
    });
  }
  /**
   * Get file status
   */
  status(options) {
    return (options?.client ?? this._client).get({
      url: "/file/status",
      ...options
    });
  }
};
var App = class extends _HeyApiClient {
  /**
   * Write a log entry to the server logs
   */
  log(options) {
    return (options?.client ?? this._client).post({
      url: "/log",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * List all agents
   */
  agents(options) {
    return (options?.client ?? this._client).get({
      url: "/agent",
      ...options
    });
  }
};
var Auth = class extends _HeyApiClient {
  /**
   * Remove OAuth credentials for an MCP server
   */
  remove(options) {
    return (options.client ?? this._client).delete({
      url: "/mcp/{name}/auth",
      ...options
    });
  }
  /**
   * Start OAuth authentication flow for an MCP server
   */
  start(options) {
    return (options.client ?? this._client).post({
      url: "/mcp/{name}/auth",
      ...options
    });
  }
  /**
   * Complete OAuth authentication with authorization code
   */
  callback(options) {
    return (options.client ?? this._client).post({
      url: "/mcp/{name}/auth/callback",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  /**
   * Start OAuth flow and wait for callback (opens browser)
   */
  authenticate(options) {
    return (options.client ?? this._client).post({
      url: "/mcp/{name}/auth/authenticate",
      ...options
    });
  }
  /**
   * Set authentication credentials
   */
  set(options) {
    return (options.client ?? this._client).put({
      url: "/auth/{id}",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
};
var Mcp = class extends _HeyApiClient {
  /**
   * Get MCP server status
   */
  status(options) {
    return (options?.client ?? this._client).get({
      url: "/mcp",
      ...options
    });
  }
  /**
   * Add MCP server dynamically
   */
  add(options) {
    return (options?.client ?? this._client).post({
      url: "/mcp",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * Connect an MCP server
   */
  connect(options) {
    return (options.client ?? this._client).post({
      url: "/mcp/{name}/connect",
      ...options
    });
  }
  /**
   * Disconnect an MCP server
   */
  disconnect(options) {
    return (options.client ?? this._client).post({
      url: "/mcp/{name}/disconnect",
      ...options
    });
  }
  auth = new Auth({ client: this._client });
};
var Lsp = class extends _HeyApiClient {
  /**
   * Get LSP server status
   */
  status(options) {
    return (options?.client ?? this._client).get({
      url: "/lsp",
      ...options
    });
  }
};
var Formatter = class extends _HeyApiClient {
  /**
   * Get formatter status
   */
  status(options) {
    return (options?.client ?? this._client).get({
      url: "/formatter",
      ...options
    });
  }
};
var Control = class extends _HeyApiClient {
  /**
   * Get the next TUI request from the queue
   */
  next(options) {
    return (options?.client ?? this._client).get({
      url: "/tui/control/next",
      ...options
    });
  }
  /**
   * Submit a response to the TUI request queue
   */
  response(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/control/response",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
};
var Tui = class extends _HeyApiClient {
  /**
   * Append prompt to the TUI
   */
  appendPrompt(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/append-prompt",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * Open the help dialog
   */
  openHelp(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/open-help",
      ...options
    });
  }
  /**
   * Open the session dialog
   */
  openSessions(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/open-sessions",
      ...options
    });
  }
  /**
   * Open the theme dialog
   */
  openThemes(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/open-themes",
      ...options
    });
  }
  /**
   * Open the model dialog
   */
  openModels(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/open-models",
      ...options
    });
  }
  /**
   * Submit the prompt
   */
  submitPrompt(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/submit-prompt",
      ...options
    });
  }
  /**
   * Clear the prompt
   */
  clearPrompt(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/clear-prompt",
      ...options
    });
  }
  /**
   * Execute a TUI command (e.g. agent_cycle)
   */
  executeCommand(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/execute-command",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * Show a toast notification in the TUI
   */
  showToast(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/show-toast",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
   * Publish a TUI event
   */
  publish(options) {
    return (options?.client ?? this._client).post({
      url: "/tui/publish",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  control = new Control({ client: this._client });
};
var Event = class extends _HeyApiClient {
  /**
   * Get events
   */
  subscribe(options) {
    return (options?.client ?? this._client).get.sse({
      url: "/event",
      ...options
    });
  }
};
var OpencodeClient = class extends _HeyApiClient {
  /**
   * Respond to a permission request
   */
  postSessionIdPermissionsPermissionId(options) {
    return (options.client ?? this._client).post({
      url: "/session/{id}/permissions/{permissionID}",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  }
  global = new Global({ client: this._client });
  project = new Project({ client: this._client });
  pty = new Pty({ client: this._client });
  config = new Config({ client: this._client });
  tool = new Tool({ client: this._client });
  instance = new Instance({ client: this._client });
  path = new Path({ client: this._client });
  vcs = new Vcs({ client: this._client });
  session = new Session({ client: this._client });
  command = new Command({ client: this._client });
  provider = new Provider({ client: this._client });
  find = new Find({ client: this._client });
  file = new File({ client: this._client });
  app = new App({ client: this._client });
  mcp = new Mcp({ client: this._client });
  lsp = new Lsp({ client: this._client });
  formatter = new Formatter({ client: this._client });
  tui = new Tui({ client: this._client });
  auth = new Auth({ client: this._client });
  event = new Event({ client: this._client });
};

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/client.js
function createOpencodeClient(config2) {
  if (!config2?.fetch) {
    const customFetch = (req) => {
      req.timeout = false;
      return fetch(req);
    };
    config2 = {
      ...config2,
      fetch: customFetch
    };
  }
  if (config2?.directory) {
    config2.headers = {
      ...config2.headers,
      "x-opencode-directory": encodeURIComponent(config2.directory)
    };
  }
  const client2 = createClient(config2);
  return new OpencodeClient({ client: client2 });
}

// node_modules/.pnpm/@opencode-ai+sdk@1.2.18/node_modules/@opencode-ai/sdk/dist/server.js
import { spawn } from "node:child_process";
async function createOpencodeServer(options) {
  options = Object.assign({
    hostname: "127.0.0.1",
    port: 4096,
    timeout: 5e3
  }, options ?? {});
  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`];
  if (options.config?.logLevel)
    args.push(`--log-level=${options.config.logLevel}`);
  const proc = spawn(`opencode`, args, {
    signal: options.signal,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {})
    }
  });
  const url = await new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`));
    }, options.timeout);
    let output = "";
    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            throw new Error(`Failed to parse server url from output: ${line}`);
          }
          clearTimeout(id);
          resolve(match[1]);
          return;
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(id);
      let msg = `Server exited with code ${code}`;
      if (output.trim()) {
        msg += `
Server output: ${output}`;
      }
      reject(new Error(msg));
    });
    proc.on("error", (error) => {
      clearTimeout(id);
      reject(error);
    });
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new Error("Aborted"));
      });
    }
  });
  return {
    url,
    close() {
      proc.kill();
    }
  };
}

// src-tauri/resources/agent-bridge-opencode.mjs
import { appendFileSync } from "fs";
import { createServer } from "net";
import { homedir } from "os";
import { join } from "path";
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
var opencodebin = join(homedir(), ".opencode", "bin");
if (!process.env.PATH?.includes(opencodebin)) {
  process.env.PATH = `${opencodebin}:${process.env.PATH || ""}`;
}
var logFile = "/tmp/agent-bridge-opencode-debug.log";
var log = (msg) => {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  process.stderr.write(line);
  try {
    appendFileSync(logFile, line);
  } catch {
  }
};
var config = JSON.parse(process.argv[2] || "{}");
var { sessionId, cwd: initialCwd, permissionMode: configPermissionMode } = config;
var currentCwd = initialCwd;
var currentPermissionMode = configPermissionMode || "bypassPermissions";
var permissionResolve = null;
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
if (config.mode === "list-models") {
  (async () => {
    try {
      const port = await getFreePort();
      const server = await createOpencodeServer({ port, timeout: 3e4 });
      const client2 = createOpencodeClient({ baseUrl: server.url, directory: process.cwd() });
      const result = await client2.provider.list();
      const providers = result.data?.all || [];
      const models = [];
      for (const provider of providers) {
        for (const model of Object.values(provider.models || {})) {
          if (!model.capabilities?.toolcall) continue;
          if (model.providerID !== "opencode") continue;
          if (model.cost?.input !== 0 || model.cost?.output !== 0) continue;
          models.push({
            id: model.id,
            providerID: model.providerID,
            name: model.name || model.id,
            free: true,
            costIn: 0,
            costOut: 0
          });
        }
      }
      process.stdout.write(JSON.stringify(models) + "\n");
      await server.kill();
    } catch (err) {
      log(`list-models failed: ${err.message}`);
    }
    process.exit(0);
  })();
} else {
  let handleEvent = function(event) {
    if (!event || !event.type) return;
    const props = event.properties || {};
    const eventSessionId = props.sessionID || props.info?.sessionID;
    if (eventSessionId && ocSessionId && eventSessionId !== ocSessionId) return;
    switch (event.type) {
      case "session.status": {
        const status = props.status;
        if (status?.type === "busy") {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        } else if (status?.type === "idle") {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleTimer = null;
            emitQueryComplete();
          }, 500);
        } else if (status?.type === "retry") {
          const attempt = status.attempt || 0;
          const retryMsg = status.message || `Retrying (attempt ${attempt})...`;
          log(`Session retry: ${retryMsg}`);
          emit({
            type: "assistant",
            message: {
              id: `retry-${Date.now()}`,
              role: "assistant",
              content: [{ type: "text", text: `\u23F3 ${retryMsg}` }],
              model: "",
              stop_reason: null
            }
          });
        }
        break;
      }
      case "message.updated": {
        const info = props.info;
        if (!info) break;
        if (info.role === "user") {
          userMessageIds.add(info.id);
          break;
        }
        if (info.role === "assistant") {
          currentMessageId = info.id;
          if (info.time?.completed) {
            emit({
              type: "result",
              subtype: "result",
              result: "",
              cost_usd: info.cost || 0,
              usage: {
                input_tokens: info.tokens?.input || 0,
                output_tokens: info.tokens?.output || 0,
                cache_read_input_tokens: info.tokens?.cache?.read || 0,
                cache_creation_input_tokens: info.tokens?.cache?.write || 0
              },
              session_id: ocSessionId
            });
          }
        }
        break;
      }
      case "message.part.updated": {
        const part = props.part;
        const delta = props.delta;
        if (!part) break;
        if (part.messageID && userMessageIds.has(part.messageID)) break;
        if (currentMessageId && part.messageID !== currentMessageId) {
          currentMessageId = part.messageID;
        }
        partsById.set(part.id, part);
        emitPartAsAssistantMessage(part, delta);
        break;
      }
      case "permission.updated": {
        const permission = props;
        log(`Permission requested: ${permission.type} \u2014 ${permission.title} (mode=${currentPermissionMode})`);
        if (currentPermissionMode === "bypassPermissions") {
          client2.postSessionIdPermissionsPermissionId({
            path: {
              id: permission.sessionID,
              permissionId: permission.id
            },
            body: { allow: true }
          }).catch((err) => log(`Failed to approve permission: ${err.message}`));
        } else {
          emit({
            type: "permission_request",
            toolName: permission.title || permission.type || "unknown",
            input: permission.metadata || {}
          });
          const sid = permission.sessionID;
          const pid = permission.id;
          new Promise((resolve) => {
            permissionResolve = resolve;
          }).then((allowed) => {
            log(`Permission ${pid}: ${allowed ? "allow" : "deny"}`);
            client2.postSessionIdPermissionsPermissionId({
              path: { id: sid, permissionId: pid },
              body: { allow: !!allowed }
            }).catch((err) => log(`Failed to respond to permission: ${err.message}`));
          });
        }
        break;
      }
      case "message.part.removed": {
        const part = props.part;
        if (!part) break;
        const msgId = part.messageID || currentMessageId || `msg-${Date.now()}`;
        emit({
          type: "assistant",
          message: {
            id: msgId,
            role: "assistant",
            content: [{ type: "text", text: "" }],
            model: "",
            stop_reason: null
          }
        });
        partsById.delete(part.id);
        break;
      }
      case "session.error": {
        const error = props.error;
        const msg = error?.data?.message || error?.name || "Unknown OpenCode error";
        log(`Session error: ${msg}`);
        emit({ type: "error", error: msg });
        break;
      }
      default:
        break;
    }
  }, emitPartAsAssistantMessage = function(part, delta) {
    const blocks = [];
    switch (part.type) {
      case "text": {
        const text = part.text || "";
        const questionsMatch = text.match(/\bquestions\s*:?\s*(\[[\s\S]*\])/i);
        if (questionsMatch) {
          try {
            const parsed = JSON.parse(questionsMatch[1]);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const toolId = `ask-${part.id || Date.now()}`;
              const questions = parsed.map((q) => ({
                question: q.question || q.label || "",
                header: q.header || void 0,
                options: Array.isArray(q.options) ? q.options : void 0
              }));
              blocks.push({
                type: "tool_use",
                id: toolId,
                name: "AskUserQuestion",
                input: { questions }
              });
              const before = text.slice(0, text.indexOf(questionsMatch[0])).trim();
              if (before) {
                blocks.unshift({ type: "text", text: before });
              }
              break;
            }
          } catch {
          }
        }
        blocks.push({ type: "text", text });
        break;
      }
      case "reasoning": {
        blocks.push({ type: "thinking", thinking: part.text || "" });
        break;
      }
      case "tool": {
        const state = part.state;
        blocks.push({
          type: "tool_use",
          id: part.callID || part.id,
          name: part.tool,
          input: state?.input || {}
        });
        if (state?.status === "completed") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.callID || part.id,
            content: state.output || "",
            is_error: false
          });
        } else if (state?.status === "error") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.callID || part.id,
            content: state.error || "Tool error",
            is_error: true
          });
        }
        break;
      }
      case "subtask": {
        const toolId = `subtask-${part.id || Date.now()}`;
        blocks.push({
          type: "tool_use",
          id: toolId,
          name: "Agent",
          input: {
            prompt: part.prompt || part.description || "Subtask",
            description: part.description || part.prompt || "Running subtask"
          }
        });
        if (part.state?.status === "completed") {
          blocks.push({
            type: "tool_result",
            tool_use_id: toolId,
            content: part.state.output || "Subtask completed",
            is_error: false
          });
        } else if (part.state?.status === "error") {
          blocks.push({
            type: "tool_result",
            tool_use_id: toolId,
            content: part.state.error || "Subtask failed",
            is_error: true
          });
        }
        break;
      }
      case "file": {
        const filename = part.filename || part.url || "file";
        const mime = part.mime || "";
        blocks.push({
          type: "text",
          text: `\u{1F4CE} File: ${filename}${mime ? ` (${mime})` : ""}`
        });
        break;
      }
      case "agent":
      case "step-start":
      case "step-finish":
      case "snapshot":
      case "patch":
      case "compaction":
      case "retry":
        return;
      default:
        return;
    }
    if (blocks.length > 0) {
      emit({
        type: "assistant",
        message: {
          id: part.messageID || `msg-${Date.now()}`,
          role: "assistant",
          content: blocks,
          model: "",
          stop_reason: null
        }
      });
    }
  }, emitQueryComplete = function() {
    currentMessageId = null;
    partsById.clear();
    emit({ type: "query_complete" });
  };
  handleEvent2 = handleEvent, emitPartAsAssistantMessage2 = emitPartAsAssistantMessage, emitQueryComplete2 = emitQueryComplete;
  let client2;
  let server;
  let bootPromise;
  let ocSessionId = null;
  let currentMessageId = null;
  let idleTimer = null;
  const userMessageIds = /* @__PURE__ */ new Set();
  const partsById = /* @__PURE__ */ new Map();
  async function boot() {
    log(`Booting OpenCode server (cwd=${currentCwd})`);
    try {
      const port = await getFreePort();
      log(`Using port ${port}`);
      const serverConfig = {};
      if (config.model) {
        serverConfig.model = config.model;
        log(`Setting OpenCode model: ${config.model}`);
      }
      server = await createOpencodeServer({
        port,
        timeout: 3e4,
        config: serverConfig
      });
      client2 = createOpencodeClient({
        baseUrl: server.url,
        directory: currentCwd
      });
      log(`OpenCode server started at ${server.url}`);
    } catch (err) {
      log(`Failed to start OpenCode server: ${err.message}`);
      emit({ type: "error", error: `Failed to start OpenCode: ${err.message}` });
      process.exit(1);
    }
    try {
      const sse = await client2.event.subscribe();
      readEvents(sse);
    } catch (err) {
      log(`Failed to subscribe to events: ${err.message}`);
      emit({ type: "error", error: `Failed to subscribe to OpenCode events: ${err.message}` });
    }
    emit({
      type: "system",
      subtype: "bridge_ready",
      sessionId,
      cwd: currentCwd || process.cwd()
    });
    fetchAndEmitModels();
  }
  async function fetchAndEmitModels() {
    try {
      const result = await client2.provider.list();
      const providers = result.data?.all || [];
      const unique = [];
      for (const provider of providers) {
        for (const model of Object.values(provider.models || {})) {
          if (!model.capabilities?.toolcall) continue;
          if (model.providerID !== "opencode") continue;
          if (model.cost?.input !== 0 || model.cost?.output !== 0) continue;
          unique.push({
            id: model.id,
            providerID: model.providerID,
            name: model.name || model.id,
            free: true,
            costIn: 0,
            costOut: 0
          });
        }
      }
      log(`Fetched ${unique.length} models (${unique.filter((m) => m.free).length} free)`);
      emit({ type: "available_models", models: unique });
    } catch (err) {
      log(`Failed to fetch models: ${err.message}`);
    }
  }
  async function readEvents(sse) {
    try {
      for await (const event of sse.stream) {
        try {
          handleEvent(event);
        } catch (err) {
          log(`Error handling event: ${err.message}`);
        }
      }
    } catch (err) {
      log(`SSE stream error: ${err.message}`);
    }
    log("SSE stream ended");
  }
  let stdinBuf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    stdinBuf += chunk;
    let newlineIdx;
    while ((newlineIdx = stdinBuf.indexOf("\n")) !== -1) {
      const line = stdinBuf.slice(0, newlineIdx).trim();
      stdinBuf = stdinBuf.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        handleStdinMessage(msg);
      } catch (err) {
        emit({ type: "error", error: `Invalid JSON on stdin: ${err.message}` });
      }
    }
  });
  process.stdin.on("end", () => {
    if (server) server.close();
    process.exit(0);
  });
  async function handleStdinMessage(msg) {
    if (msg.type === "abort") {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (permissionResolve) {
        permissionResolve(false);
        permissionResolve = null;
      }
      if (ocSessionId) {
        try {
          await client2.session.abort({ path: { id: ocSessionId } });
        } catch (err) {
          log(`Failed to abort session: ${err.message}`);
        }
      }
      emit({ type: "aborted" });
      return;
    }
    if (msg.type === "set_cwd") {
      currentCwd = msg.cwd;
      log(`cwd updated to: ${currentCwd}`);
      emit({ type: "cwd_updated", cwd: currentCwd });
      return;
    }
    if (msg.type === "permission_response") {
      if (permissionResolve) {
        log(`Resolving permission: ${msg.allowed ? "allow" : "deny"}`);
        permissionResolve(msg.allowed);
        permissionResolve = null;
      } else {
        log("permission_response received but no pending permissionResolve \u2014 ignoring");
      }
      return;
    }
    if (msg.type === "set_permission_mode") {
      currentPermissionMode = msg.permissionMode || "bypassPermissions";
      log(`permissionMode updated to: ${currentPermissionMode}`);
      emit({ type: "permission_mode_updated", permissionMode: currentPermissionMode });
      return;
    }
    if (msg.type === "set_model") {
      config.model = msg.model || null;
      log(`model updated to: ${config.model}`);
      emit({ type: "model_updated", model: config.model });
      return;
    }
    if (msg.type === "get_usage") {
      try {
        await bootPromise;
        const status = await client2.session.status();
        emit({ type: "opencode_usage", data: status.data || status });
      } catch (err) {
        log(`Failed to get usage: ${err.message}`);
        emit({ type: "opencode_usage", data: null, error: err.message });
      }
      return;
    }
    if (msg.type === "ask_user_answer") {
      const answer = msg.answer || {};
      const answerText = Object.entries(answer).map(([q, a]) => `${q}: ${a}`).join("\n");
      if (answerText) {
        await sendPrompt(answerText);
      }
      return;
    }
    if (msg.type === "user") {
      await sendPrompt(msg.message);
      return;
    }
    emit({ type: "error", error: `Unknown stdin message type: ${msg.type}` });
  }
  async function sendPrompt(userMessage) {
    let text;
    if (typeof userMessage === "string") {
      text = userMessage;
    } else if (Array.isArray(userMessage.content)) {
      text = userMessage.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    } else if (typeof userMessage.content === "string") {
      text = userMessage.content;
    } else {
      text = String(userMessage);
    }
    if (!text) {
      emit({ type: "error", error: "Empty message" });
      return;
    }
    try {
      await bootPromise;
      if (!ocSessionId) {
        const session = await client2.session.create({
          body: { title: text.substring(0, 100) }
        });
        if (session.error || !session.data) {
          const errMsg = session.error?.message || session.error || "Unknown error creating session";
          log(`Failed to create session: ${JSON.stringify(errMsg)}`);
          emit({ type: "error", error: `Failed to create OpenCode session: ${errMsg}` });
          return;
        }
        ocSessionId = session.data.id;
        log(`OpenCode session created: ${ocSessionId}`);
        emit({
          type: "system",
          subtype: "init",
          session_id: ocSessionId
        });
      }
      const promptBody = {
        parts: [{ type: "text", text }]
      };
      if (config.model) {
        const slash = config.model.indexOf("/");
        if (slash > 0) {
          promptBody.model = {
            providerID: config.model.substring(0, slash),
            modelID: config.model.substring(slash + 1)
          };
        } else {
          promptBody.model = {
            providerID: config.model,
            modelID: config.model
          };
        }
        log(`Using model: ${JSON.stringify(promptBody.model)}`);
      }
      await client2.session.promptAsync({
        path: { id: ocSessionId },
        body: promptBody
      });
      log(`Prompt sent to OpenCode session ${ocSessionId}`);
    } catch (err) {
      log(`Failed to send prompt: ${err.message}
${err.stack}`);
      emit({ type: "error", error: `Failed to send prompt: ${err.message}` });
    }
  }
  bootPromise = boot();
}
var handleEvent2;
var emitPartAsAssistantMessage2;
var emitQueryComplete2;
