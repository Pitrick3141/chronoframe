export default defineNitroPlugin(() => {
  // Seeding is an explicit administrative action. Never perform database I/O
  // while a Worker isolate is starting.
})
