import fs from 'fs';
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log("No key");
} else {
  console.log("Key length:", key.length, "Starts with:", key.substring(0, 3));
  if (key === "MY_GEMINI_API_KEY") console.log("It's literally MY_GEMINI_API_KEY");
}
