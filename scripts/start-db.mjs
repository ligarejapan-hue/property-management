import EmbeddedPostgres from "embedded-postgres";
import fs from "fs";

const pg = new EmbeddedPostgres({
  databaseDir: "./tmp/pg-data",
  user: "postgres",
  password: "postgres",
  port: 5432,
  persistent: true,
});

async function main() {
  console.log("Starting embedded PostgreSQL...");

  // Only initialise if data directory doesn't exist yet
  const dataExists = fs.existsSync("./tmp/pg-data/PG_VERSION");
  if (!dataExists) {
    await pg.initialise();
    console.log("Database cluster initialised.");
  } else {
    console.log("Data directory already exists, skipping initialise.");
  }

  await pg.start();
  console.log("PostgreSQL started on port 5432");

  try {
    await pg.createDatabase("property_management");
    console.log("Database property_management created");
  } catch (e) {
    console.log("Database already exists (OK)");
  }

  console.log("DB ready. Press Ctrl+C to stop.");
  process.on("SIGINT", async () => {
    await pg.stop();
    process.exit(0);
  });
}
main().catch(console.error);
