/**
 * Where the OAuth `state` is kept between starting the flow and coming back.
 *
 * `sessionStorage`, not a cookie: it is a CSRF check, it only needs to survive
 * one redirect in one tab, and it must not be sent anywhere. The server mints
 * the value; the browser only remembers it long enough to compare.
 */
export const OAUTH_STATE_KEY = "peakswift.gmail.oauth-state";
