// Lua VM shims that make BullMQ's Redis Lua scripts runnable on ioredis-mock
// (hermetic tests — SPEC §12.2: "BullMQ tests use an in-process Redis stub").
//
// ioredis-mock executes `defineCommand`/`eval` Lua in a fengari VM (pure JS).
// Real Redis exposes two extra C libraries to scripts that fengari does not:
//   · cmsgpack — BullMQ packs script ARGV with msgpackr (JS side) and every
//     script starts with `cmsgpack.unpack(ARGV[…])`. Pack NEVER happens in
//     BullMQ lua (verified for v5.81: zero `cmsgpack.pack` call sites) and
//     everything persisted goes through `cjson.encode`, so unpack-only is
//     sufficient and no binary blob ever round-trips through a Redis value
//     (ioredis-mock stores JS strings; msgpack Buffers arrive in the VM as
//     userdata and are unpacked directly from the original Buffer — lossless).
//   · cjson    — used to encode/decode job opts etc. into plain JSON strings.
//
// Two further ioredis-mock gaps are patched through the same hook:
//   · XTRIM is unsupported. BullMQ only uses it to bound the events stream
//     (MAXLEN ~ 10000 housekeeping); we no-op it. Events simply accumulate.
//   · fengari-interop pushes JS arrays as userdata proxies whose null
//     elements become TRUTHY userdata (tostring 'null'). BullMQ nil-checks on
//     HMGET results (e.g. meta paused/concurrency in getTargetQueueList) then
//     misfire and jobs silently route to the paused list. We convert HMGET
//     results to real lua tables with proper nils.
//
// Installation: ioredis-mock holds `lua`/`lualib`/`lauxlib` object references
// from require('fengari') and calls luaL_openlibs on every new VM — patching
// the shared module objects below covers every VM created afterwards, for
// every ioredis-mock instance in this process. installBullMqLuaShims() is
// idempotent; call it before creating mock connections.
import { lua, lualib, to_luastring } from 'fengari';
import interop from 'fengari-interop';
import { unpackMultiple } from 'msgpackr';

const LUA_TBOOLEAN = 1;
const LUA_TSTRING = 4;

/** msgpackr-encoded script ARGV arrive in the VM as userdata (the original
 * Buffer/Uint8Array); plain strings are decoded latin1-style as a fallback. */
function msgpackBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'latin1');
  throw new Error('cmsgpack.unpack: expected a buffer or string argument');
}

/** Recursively push a JS value (msgpackr/JSON output shape) as lua values. */
function pushJs(L: unknown, value: unknown): void {
  if (value === null || value === undefined) {
    lua.lua_pushnil(L);
    return;
  }
  if (typeof value === 'boolean') {
    lua.lua_pushboolean(L, value ? 1 : 0);
    return;
  }
  if (typeof value === 'number') {
    lua.lua_pushnumber(L, value);
    return;
  }
  if (typeof value === 'string') {
    lua.lua_pushstring(L, to_luastring(value));
    return;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    lua.lua_pushstring(L, to_luastring(Buffer.from(value).toString('latin1')));
    return;
  }
  if (Array.isArray(value)) {
    lua.lua_newtable(L);
    const t = lua.lua_gettop(L);
    value.forEach((element, i) => {
      lua.lua_pushinteger(L, i + 1);
      pushJs(L, element);
      lua.lua_settable(L, t);
    });
    return;
  }
  if (typeof value === 'object') {
    lua.lua_newtable(L);
    const t = lua.lua_gettop(L);
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      lua.lua_pushstring(L, to_luastring(key));
      pushJs(L, val);
      lua.lua_settable(L, t);
    }
    return;
  }
  lua.lua_pushnil(L);
}

/** Recursively convert a lua value at stack index `idx` to a JS value.
 * Userdata (e.g. msgpack Buffers) returns the original JS object. */
function luaToJs(L: unknown, idx: number): unknown {
  const t = lua.lua_type(L, idx);
  switch (t) {
    case 0: // LUA_TNIL
      return null;
    case 1: // LUA_TBOOLEAN
      return lua.lua_toboolean(L, idx) !== 0;
    case 3: // LUA_TNUMBER
      return lua.lua_tonumber(L, idx);
    case 4: // LUA_TSTRING
      return lua.lua_tojsstring(L, idx);
    case 5: { // LUA_TTABLE
      lua.lua_pushvalue(L, idx);
      const top = lua.lua_gettop(L);
      const entries: Array<[string | number, unknown]> = [];
      let isArray = true;
      lua.lua_pushnil(L);
      while (lua.lua_next(L, top) !== 0) {
        const keyType = lua.lua_type(L, -2);
        const key =
          keyType === 3 ? lua.lua_tonumber(L, -2) : String(lua.lua_tojsstring(L, -2));
        const val = luaToJs(L, -1);
        lua.lua_pop(L, 1);
        entries.push([key, val]);
        if (typeof key !== 'number' || key !== entries.length) isArray = false;
      }
      lua.lua_pop(L, 1);
      if (entries.length === 0) return {};
      if (isArray) return entries.map(([, v]) => v);
      const obj: Record<string, unknown> = {};
      for (const [k, v] of entries) obj[String(k)] = v;
      return obj;
    }
    default:
      // userdata / function / thread: recover the original JS reference.
      return interop.tojs(L, idx);
  }
}

function cmsgpackUnpack(L: unknown): number {
  const values = unpackMultiple(msgpackBytes(luaToJs(L, 1)));
  for (const value of values) pushJs(L, value);
  return values.length;
}

function cjsonEncode(L: unknown): number {
  lua.lua_pushstring(L, to_luastring(JSON.stringify(luaToJs(L, 1) ?? null)));
  return 1;
}

function cjsonDecode(L: unknown): number {
  pushJs(L, JSON.parse(String(luaToJs(L, 1))));
  return 1;
}

const originalOpenlibs = lualib.luaL_openlibs;
const originalPushJsFunction = lua.lua_pushjsfunction;

/** Wrap a jsfunction so a JS throw surfaces as a proper lua string error
 * (fengari otherwise propagates the JS Error object, which ioredis-mock
 * stringifies as an unhelpful `null`). */
function wrapJsFunction(fn: (L: unknown) => number): (L: unknown) => number {
  return (L: unknown) => {
    try {
      // Intercept redis.call/redis.pcall invocations: arg1 is the boolean
      // pcall flag, arg2 the command name.
      if (lua.lua_type(L, 1) === LUA_TBOOLEAN && lua.lua_type(L, 2) === LUA_TSTRING) {
        const name = lua.lua_tojsstring(L, 2);
        if (typeof name === 'string') {
          const command = name.toLowerCase();
          if (command === 'xtrim') {
            // Unsupported by ioredis-mock; housekeeping only — see header.
            lua.lua_pushnil(L);
            return 1;
          }
          if (command === 'hmget') {
            const returnCount = fn(L);
            if (returnCount < 1) return returnCount;
            const result = interop.tojs(L, -1);
            if (!Array.isArray(result)) return returnCount;
            lua.lua_pop(L, returnCount);
            // The bridge unshifts a null placeholder for 1-based lua access.
            const values = result[0] === null ? result.slice(1) : result;
            lua.lua_newtable(L);
            const t = lua.lua_gettop(L);
            values.forEach((value, i) => {
              if (value === null || value === undefined) return; // real lua nil
              lua.lua_pushinteger(L, i + 1);
              interop.push(L, value);
              lua.lua_settable(L, t);
            });
            return 1;
          }
        }
      }
      return fn(L);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lua.lua_pushstring(L, to_luastring(message));
      return lua.lua_error(L);
    }
  };
}

let installed = false;

/**
 * Install the shims (idempotent, process-global). Must run BEFORE any
 * ioredis-mock Lua script executes (VMs are created per script execution, so
 * any time before the first BullMQ operation is fine).
 */
export function installBullMqLuaShims(): void {
  if (installed) return;
  installed = true;

  lualib.luaL_openlibs = (L: unknown) => {
    originalOpenlibs(L);
    lua.lua_newtable(L);
    lua.lua_pushjsfunction(L, cmsgpackUnpack);
    lua.lua_setfield(L, -2, to_luastring('unpack'));
    lua.lua_setglobal(L, to_luastring('cmsgpack'));
    lua.lua_newtable(L);
    lua.lua_pushjsfunction(L, cjsonEncode);
    lua.lua_setfield(L, -2, to_luastring('encode'));
    lua.lua_pushjsfunction(L, cjsonDecode);
    lua.lua_setfield(L, -2, to_luastring('decode'));
    lua.lua_setglobal(L, to_luastring('cjson'));
  };

  lua.lua_pushjsfunction = (L: unknown, fn: (L: unknown) => number) =>
    originalPushJsFunction(L, wrapJsFunction(fn));
}
