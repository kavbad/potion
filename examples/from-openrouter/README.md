# summarize

Reads a text file and prints a 3-bullet summary. Originally on OpenRouter (`openai/gpt-4.1`), now routed through Potion (`potion-auto`); the old values are left commented in `summarize.ts`.

    npm install
    POTION_API_KEY=... npx tsx summarize.ts input.txt

`SUMMARY_MODEL=fast|default|best` is still accepted but every choice currently maps to `potion-auto` — the rule bound to your key picks the model. The last line printed is Potion's receipt (`x-frontier-trace`); if it is missing the request did not go through Potion.
