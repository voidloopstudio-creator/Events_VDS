const bcrypt = require("bcryptjs");

function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") throw new Error("Lance cette commande dans un vrai terminal interactif.");
  return new Promise((resolve, reject) => {
    let password = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(password);
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Saisie annulée."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1);
        else if (character >= " " && character !== "\u007f") password += character;
      }
    };
    input.on("data", onData);
  });
}

(async () => {
  const password = await readHidden("Nouveau mot de passe staff (16 caractères minimum, saisie masquée) : ");
  if (password.length < 16) {
    console.error("Le mot de passe doit contenir au moins 16 caractères.");
    process.exitCode = 1;
    return;
  }
  console.log("Copie cette valeur dans Render → Environment → STAFF_PASSWORD_HASH :");
  console.log(await bcrypt.hash(password, 12));
})();
