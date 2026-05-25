// Fixture: third-party module patch. No real upstream behaviour — just
// appends a marker so the loader/manifest validator has something to chew on.
export default {
  description: 'example-module/hello fixture patch',
  verify: { present: 'EX-MOD-HELLO' },
  apply: (code) => code + ' EX-MOD-HELLO',
};
