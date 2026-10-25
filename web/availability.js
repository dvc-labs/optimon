/** Public availability flags contain no readings and never turn missing data into zeroes. */
export function isFallbackResponse(response) {
  return response.headers.get('X-Optimon-Fallback') === '1';
}

export function hasFreshReading(payload) {
  return (
    payload?.data?.schema === 1 &&
    payload.status?.state === 'live' &&
    Number.isFinite(payload.status.ageSeconds) &&
    payload.status.ageSeconds >= 0 &&
    payload.status.ageSeconds <= 180
  );
}
