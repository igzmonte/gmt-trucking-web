import { handleRequest } from "../src/app.mjs";

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
