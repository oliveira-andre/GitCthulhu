// Must load before prismjs: stops it from highlighting the page by itself.
(globalThis as { Prism?: { manual?: boolean } }).Prism = { manual: true };
export {};
