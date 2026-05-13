export function getIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

export function authorized(req) {
  const pw = req.headers?.['x-access-password'];
  return !!(process.env.ACCESS_PASSWORD && pw === process.env.ACCESS_PASSWORD);
}
