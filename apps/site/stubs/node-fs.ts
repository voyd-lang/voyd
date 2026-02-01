// Browser stub for `node:fs`. This should never run in the browser.
const fs = {
  readFileSync: (..._args: any[]) => {
    throw new Error("fs.readFileSync is not available in the browser");
  },
};

export default fs;

