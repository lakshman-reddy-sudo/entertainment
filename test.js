const { handler } = require('./netlify/functions/api.js');
async function test() {
  const req = {
    httpMethod: "GET",
    path: "/stream/movie/tt0816692.json",
    headers: {},
    queryStringParameters: {}
  };
  console.log("Starting test...");
  const t0 = Date.now();
  try {
    const res = await handler(req, {});
    console.log(`Finished in ${Date.now() - t0}ms`);
    console.log(res);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
