// Prints the env object this process was spawned with. It does not import the
// env module and it is started with --no-env-file from a directory that has no
// dotenv file, so it reports only the parent spawn env.
console.log(process.env.HINDSIGHT_API_URL ?? "");
