// Fixture: exact-version variant for example_versioned at 2.1.148.
export default {
  description: 'example_versioned for exactly 2.1.148 (fixture)',
  testedAgainst: ['2.1.148'],
  verify: { present: 'EV-2.1.148' },
  apply: (code) => code + ' EV-2.1.148',
};
