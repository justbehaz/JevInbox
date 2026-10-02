// Runs once when the server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startup } = await import("./instrumentation-node");
    await startup();
  }
}
