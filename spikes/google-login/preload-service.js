// Injected into the service view. Only job in this spike: keep navigator.userAgentData consistent
// with the Sec-CH-UA* headers when the client-hints strategy is active. Headers that disagree with
// the JS surface are a detection signal on their own, so a half-applied spoof is worse than none.
//
// electron#34762 is why this is needed at all: Electron never sends high-entropy hints, and only
// sends low-entropy ones after an Accept-CH response.

const arg = process.argv.find((a) => a.startsWith('--hangar-hints='));
if (arg) {
  const hints = JSON.parse(Buffer.from(arg.split('=')[1], 'base64').toString('utf8'));

  const highEntropy = {
    architecture: hints.architecture,
    bitness: hints.bitness,
    brands: hints.brands,
    fullVersionList: hints.brands.map((b) => ({
      brand: b.brand,
      version: b.brand === 'Not:A-Brand' ? '24.0.0.0' : hints.uaFullVersion,
    })),
    mobile: hints.mobile,
    model: hints.model,
    platform: hints.platform,
    platformVersion: hints.platformVersion,
    uaFullVersion: hints.uaFullVersion,
    wow64: false,
  };

  const uaData = {
    brands: hints.brands,
    mobile: hints.mobile,
    platform: hints.platform,
    getHighEntropyValues: (keys) =>
      Promise.resolve(
        Object.fromEntries(
          ['brands', 'mobile', 'platform', ...keys].map((k) => [k, highEntropy[k]])
        )
      ),
    toJSON: () => ({ brands: hints.brands, mobile: hints.mobile, platform: hints.platform }),
  };

  try {
    Object.defineProperty(navigator, 'userAgentData', {
      value: Object.freeze(uaData),
      configurable: false,
      enumerable: true,
    });
  } catch {
    // Already locked down by the page — nothing useful to do.
  }
}
