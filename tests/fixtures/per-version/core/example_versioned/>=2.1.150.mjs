// Fixture: range variant >=2.1.150 for example_versioned.
export default {
  description: 'example_versioned for >=2.1.150 (fixture)',
  testedAgainst: ['>=2.1.150'],
  verify: { present: 'EV->=2.1.150', weak: true },
  apply: (code) => code + ' EV->=2.1.150',
};
