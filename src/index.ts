import { PORT } from "./config";
import { createApp } from "./app";
import { getDb } from "./db";
import { pollRequests } from "./request-service";

getDb();
const app = createApp();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Music Request listening on ${PORT}`);
});

setTimeout(() => {
  void pollRequests().catch((error) => console.error(error));
}, 5000);

setInterval(() => {
  void pollRequests().catch((error) => console.error(error));
}, 60_000);
