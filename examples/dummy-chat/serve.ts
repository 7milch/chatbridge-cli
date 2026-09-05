import { startDummyChat } from "./server";

const { url } = await startDummyChat(8735);
console.log(`Dummy chat running at ${url}`);
