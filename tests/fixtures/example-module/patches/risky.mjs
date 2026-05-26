// Fixture: high-risk capability patch for the install-time strict gate test.
export default {
  description: 'example-module/risky — declares high-risk capabilities',
  capabilities: ['network', 'telemetry'],
  verify: { present: 'EX-MOD-RISKY', weak: true },
  apply: (code) => code + ' EX-MOD-RISKY',
};
