import { app } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
app().listen(port, "0.0.0.0", () =>
  console.log(`DailyMeals MCP listening on ${port}`),
);
