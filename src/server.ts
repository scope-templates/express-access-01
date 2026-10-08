import { createApp } from "./app.js";
import { openDb } from "./db.js";

const port = Number(process.env.PORT ?? 3040);
createApp(openDb()).listen(port, () => {
  console.log(`access desk listening on http://localhost:${port}/admin`);
});
