// Fixture: default variant for example_versioned.
export default {
  description: 'example_versioned default fallback (fixture)',
  verify: { present: 'EV-DEFAULT' },
  apply: (code) => code + ' EV-DEFAULT',
};
