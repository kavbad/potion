// Type declarations for the untyped fengari Lua VM packages.
// Only the surface used by lua-shims.ts is declared.
declare module 'fengari' {
  export const lua: {
    LUA_TNIL: number;
    lua_type(L: unknown, idx: number): number;
    lua_typename(L: unknown, t: number): Uint8Array;
    lua_toboolean(L: unknown, idx: number): number;
    lua_tonumber(L: unknown, idx: number): number;
    lua_tointeger(L: unknown, idx: number): number;
    lua_tojsstring(L: unknown, idx: number): string | null;
    lua_pushnil(L: unknown): void;
    lua_pushboolean(L: unknown, b: number): void;
    lua_pushnumber(L: unknown, n: number): void;
    lua_pushinteger(L: unknown, n: number): void;
    lua_pushstring(L: unknown, s: Uint8Array): void;
    lua_pushjsfunction(L: unknown, fn: (L: unknown) => number): void;
    lua_newtable(L: unknown): void;
    lua_gettop(L: unknown): number;
    lua_settop(L: unknown, idx: number): void;
    lua_pop(L: unknown, n: number): void;
    lua_settable(L: unknown, idx: number): void;
    lua_setfield(L: unknown, idx: number, k: Uint8Array): void;
    lua_setglobal(L: unknown, name: Uint8Array): void;
    lua_getglobal(L: unknown, name: Uint8Array): number;
    lua_pushvalue(L: unknown, idx: number): void;
    lua_next(L: unknown, idx: number): number;
    lua_error(L: unknown): number;
    lua_close(L: unknown): void;
  };
  export const lauxlib: {
    luaL_newstate(): unknown;
    luaL_dostring(L: unknown, s: Uint8Array): number;
    luaL_openlibs(L: unknown): void;
  };
  export const lualib: {
    luaL_openlibs(L: unknown): void;
  };
  export function to_luastring(s: string | Uint8Array, cache?: boolean): Uint8Array;
  export function to_jsstring(s: Uint8Array): string;
}

declare module 'fengari-interop' {
  const interop: {
    push(L: unknown, value: unknown): void;
    tojs(L: unknown, idx: number): unknown;
    luaopen_js(L: unknown): void;
  };
  export default interop;
}
