// Loaded by npm test (node --import): every git the tests run, and every
// child that inherits this environment, commits and tags without signing,
// whatever the person's global or a test repository's config says. Git's
// environment config (GIT_CONFIG_COUNT / _KEY_n / _VALUE_n) wins over both.
// gmod's own behaviour is untouched: this only shapes the test environment.
const add = { 'commit.gpgsign': 'false', 'tag.gpgsign': 'false' };
let n = Number(process.env.GIT_CONFIG_COUNT) || 0;
for (const [key, value] of Object.entries(add)) {
  process.env[`GIT_CONFIG_KEY_${n}`] = key;
  process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  n++;
}
process.env.GIT_CONFIG_COUNT = String(n);
