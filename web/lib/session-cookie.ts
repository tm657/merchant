// Shared by proxy.ts and server code, so it has no server-only imports.
//
// In production the name carries the __Host- prefix: browsers only accept such a cookie
// when it is Secure, has Path=/ and no Domain, so no subdomain and no plain-http page can
// set, overwrite or scope it. Development keeps a plain name (plain http).
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-mp_session" : "mp_session";
