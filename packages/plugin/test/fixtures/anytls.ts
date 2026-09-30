/** Synthetic Clash subscription: reserved domains and dummy credentials. */
export const ANYTLS_SUBSCRIPTION = 'proxies:\n' + Array.from({ length: 38 }, (_, index) => {
  const host = `node${String(index + 1).padStart(2, '0')}.example.test`
  return `  - name: test-node-${index + 1}\n    type: anytls\n    server: ${host}\n    port: 18888\n    password: test-password\n    sni: ${host}\n`
}).join('') + 'proxy-groups:\n  - name: test-group\n    type: select\n    proxies: [test-node-1]\n'
