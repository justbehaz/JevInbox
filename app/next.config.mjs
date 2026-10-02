/** @type {import('next').NextConfig} */
export default {
  // Native / Node-only packages stay out of the bundle.
  serverExternalPackages: ["better-sqlite3", "imapflow", "mailparser", "@napi-rs/keyring"],
  // Pin the project root so a lockfile elsewhere on the machine is not picked up.
  // Do not let the dev server generate AI-agent instruction files in the repo.
  agentRules: false,
  turbopack: { root: import.meta.dirname },
};
