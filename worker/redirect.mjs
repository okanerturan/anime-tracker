// The old address after the move to tsuzuku.okanerturan.com (2026-10-28): every request goes to the
// same path there. 308 keeps the method and body; a redirect to another host drops the Authorization
// header, so the extension rewrites its saved address instead of relying on this (1.15.0).
export default {
  fetch(request, env) {
    const from = new URL(request.url);
    return Response.redirect(`${env.TARGET}${from.pathname}${from.search}`, 308);
  }
};
