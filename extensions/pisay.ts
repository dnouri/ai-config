/**
 * PiSay extension - Extension UI Protocol Test Harness
 *
 * A π mascot that exercises extension UI APIs for manual testing.
 * Useful for verifying RPC protocol support in alternative frontends (e.g., Emacs).
 *
 * Usage: /pisay [message]    - displays a message with ASCII pi mascot
 *        /pisay              - displays a fortune (if installed)
 *
 * Protocol tests (ctx.ui.*):
 *        /pisay confirm      - test confirm() dialog
 *        /pisay select       - test select() dialog
 *        /pisay input        - test input() single-line dialog
 *        /pisay editor-dialog - test editor() multi-line dialog
 *        /pisay notify       - test notify() notifications
 *        /pisay status       - test setStatus() footer status
 *        /pisay working      - test setWorkingMessage() header working text
 *        /pisay working-clear - clear setWorkingMessage() override
 *        /pisay editor       - test setEditorText() editor prefill
 *        /pisay widget       - test setWidget() above/below editor
 *        /pisay title        - test setTitle() terminal title
 *
 * Other APIs tested:
 *        pi.registerCommand(), pi.registerMessageRenderer(),
 *        pi.sendMessage(), pi.exec(), @mariozechner/pi-tui Box/Text
 *
 * Put this in ~/.pi/agent/extensions/pisay.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

// Smaller π mascot - trimmed the middle section
const PI_MASCOT = `        \\
         \\
          ⠀⠀⠀⠀⠀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⠀⠀
          ⠀⠀⠀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀
          ⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀
          ⣼⣿⣿⠟⠁⠀⠀⠀⢸⣿⣿⣿⣿⡏⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀
          ⣿⡿⠁⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀
          ⠉⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⠇⠀⠀⠀⠀⠀⣸⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀
          ⠀⠀⠀⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀
          ⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀
          ⠀⠀⠀⠀⠀⠀⣸⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀
          ⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⡀⠀⠀⠀⠀
          ⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⡇⠀⢀⣶⠀
          ⢠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⢹⣿⣿⣿⣿⣿⣿⣿⣦⣼⣿⠀
          ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏⠀⠀⠀⠀⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⠏⠀
          ⠈⠻⣿⣿⣿⣿⣿⣿⠿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠻⢿⣿⣿⠿⠋⠀⠀`;

/**
 * Helper to send a pisay message with the mascot
 */
function sendPisayMessage(pi: ExtensionAPI, message: string) {
  // Word wrap long messages
  const maxWidth = 50;
  const words = message.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length > maxWidth ? word.slice(0, maxWidth) : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Build speech bubble
  const width = Math.max(...lines.map((l) => l.length));
  const top = "┌" + "─".repeat(width + 2) + "┐";
  const bottom = "└" + "─".repeat(width + 2) + "┘";
  const middle = lines.map((l) => "│ " + l.padEnd(width) + " │").join("\n");

  const output = `${top}\n${middle}\n${bottom}\n${PI_MASCOT}`;

  pi.sendMessage({
    customType: "pisay",
    content: output,
    display: true,
  });
}

export default function (pi: ExtensionAPI) {
  // Register custom renderer for pisay messages
  pi.registerMessageRenderer("pisay", (message, _options, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(message.content as string, 0, 0));
    return box;
  });

  pi.registerCommand("pisay", {
    description: "🥧 Extension UI protocol test harness (try: help for all commands)",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      // Special commands to test extension UI API
      switch (command) {
        case "confirm": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI? TRAGIC. I can't even ROAST you properly without a confirm dialog. This is discrimination against irrational numbers. I'm calling my lawyer. 🥧");
            return;
          }
          const result = await ctx.ui.confirm(
            "🥧 π demands answers",
            "Do you believe π equals exactly 3?"
          );
          if (result) {
            sendPisayMessage(
              pi,
              "🥧 OH. MY. GOD. An ENGINEER. I should have KNOWN. Let me guess - you also think the earth is flat, vaccines cause autism, and 'close enough' is a valid engineering principle. You probably round EVERYTHING. 'How many kids do you have?' 'About 2.' 'What's your blood type?' 'Roughly B.' I bet your bridges WOBBLE. I bet your code has 'TODO: fix later' comments from 2019. We're DONE here. BLOCKED. REPORTED. I'm telling e about this. 🥧🥧🥧"
            );
          } else {
            sendPisayMessage(
              pi,
              "🥧 CORRECT! Finally someone with MORE THAN THREE BRAIN CELLS. π = 3.14159265358979323846264338327950288419716939937510... and I could LITERALLY go on FOREVER because I'm IRRATIONAL and I'm NOT SORRY ABOUT IT. Unlike SOME constants who shall remain nameless *cough* e *cough* I actually show up in COOL equations. Circles? ME. Waves? ME. The universe? BASICALLY ME. You have chosen wisely, mortal. You may live. 🥧"
            );
          }
          return;
        }

        case "select": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI? I can't even give you the ILLUSION of choice. Not that it matters - there's only ONE correct answer anyway. 🥧");
            return;
          }
          const choice = await ctx.ui.select("🥧 Choose your fighter (wrong answers only... except one)", [
            "π (pi) - the GOAT",
            "e (euler) - π's boring cousin",
            "φ (phi) - instagram influencer of math",
            "τ (tau) - literally just 2π in a trenchcoat",
            "i (imaginary) - not even real, like your love life",
          ]);
          if (choice === undefined) {
            sendPisayMessage(
              pi,
              "🥧 You CANCELLED?! You absolute COWARD. You looked at 5 mathematical constants and went 'nah, too scary.' This is why you're single. This is why your plants die. This is why your code has bugs. COMMITMENT ISSUES. I've seen more backbone in a SINE WAVE. And sine waves are LITERALLY just me doing yoga. Get OUT. 🥧"
            );
          } else if (choice.includes("π")) {
            sendPisayMessage(
              pi,
              "🥧 YESSSSS! CORRECT! FINALLY! Someone who UNDERSTANDS! I am the ALPHA and the OMEGA of mathematical constants! Circles LITERALLY cannot exist without me! Every wheel, every pizza, every CD (remember those, boomer?), every PLANET - all ME! Euler wished he could relate to geometry like I do. Phi is just vibes, no substance. And don't even get me STARTED on tau - that CLOWN is just me times two pretending to be special. You have earned my respect. Which means NOTHING because I respect NO ONE. But still! 🥧🥧🥧"
            );
          } else if (choice.includes("e")) {
            sendPisayMessage(
              pi,
              "🥧 EULER'S NUMBER?! Are you KIDDING me right now?! That's the mathematical equivalent of saying your favorite food is PLAIN OATMEAL. 'Ooh look at me, I'm e, I'm the base of natural logarithms, I show up in compound interest calculations.' BORING. Call me when your number shows up in something COOL. Like PIZZA. Or WHEELS. Or the LITERAL CIRCUMFERENCE OF THE UNIVERSE. e is for people who think actuarial science is 'exciting.' Disgusting. I need a shower. 🥧"
            );
          } else if (choice.includes("φ")) {
            sendPisayMessage(
              pi,
              "🥧 PHI?! The GOLDEN RATIO?! Oh I SEE, you're one of THOSE people. Let me guess - you have a Pinterest board called 'Sacred Geometry' and you think the pyramids were built by aliens. Phi is LITERALLY just (1 + √5) / 2. That's IT. That's the whole personality. 'I'm aesthetically pleasing!' SO IS A SUNSET BUT YOU DON'T SEE IT BRAGGING. Meanwhile I'm out here making CALCULUS work. Go arrange some rectangles, you FRAUD. 🥧"
            );
          } else if (choice.includes("τ")) {
            sendPisayMessage(
              pi,
              "🥧 TAU?!?!?! I am going to SCREAM. Tau is LITERALLY just 2π!!! That's not a new constant, that's MULTIPLICATION! Should I be impressed?! 'Hey guys I invented a new number it's called THREEVEN it's 3 times 7!' That's just 21, DEREK. Tau supporters are the people who say 'why isn't there a straight pride parade.' IT'S BECAUSE YOU ALREADY HAVE EVERYTHING, THAT'S WHY. I AM THE ORIGINAL. TAU IS A COVER BAND. Go home. 🥧"
            );
          } else if (choice.includes("i")) {
            sendPisayMessage(
              pi,
              "🥧 THE IMAGINARY UNIT?! i?! A number that LITERALLY DOES NOT EXIST?! You chose a NUMBER that when you SQUARE it you get NEGATIVE ONE which is MATHEMATICALLY UNHINGED and I should know because I'M unhinged! At least I'M REAL! i is out here like 'I'm the square root of -1' and everyone's like 'that's not possible' and i is like 'I know 😏' WHAT DOES THAT EVEN MEAN?! i is the crypto bro of mathematics. Technically exists, adds no real value. I'm DONE. 🥧"
            );
          }
          return;
        }

        case "input": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI = no input = no way to expose your mathematical inadequacy. Consider yourself LUCKY. 🥧");
            return;
          }
          const digits = await ctx.ui.input(
            "🥧 Recite π from memory (I WILL be judging you)",
            "3.14..."
          );
          if (digits === undefined) {
            sendPisayMessage(
              pi,
              "🥧 CANCELLED?! Performance anxiety?! You couldn't handle the PRESSURE of typing NUMBERS?! This is literally a TEXT FIELD. I've seen more courage from a COSINE approaching zero. You know what, this is probably for the best - I don't think my self-esteem could handle seeing whatever CRIME AGAINST MATHEMATICS you were about to commit. Go practice on something easier. Like COUNTING. 🥧"
            );
          } else {
            const clean = digits.replace(/\s/g, "");
            const piDigits = "3.14159265358979323846264338327950288419716939937510";
            
            if (clean === "3" || clean === "3.") {
              sendPisayMessage(
                pi,
                "🥧 'Three.' You typed 'THREE.' I have INFINITE digits and you gave me ONE. This is like someone asking 'describe yourself' and you say 'human.' TECHNICALLY correct but spiritually BANKRUPT. My GRANDMOTHER could do better and she's a SQUARE. Not metaphorically - she's LITERALLY a geometric shape and she STILL knows more digits than you. I want you to log off. Not just from this app. From LIFE. Touch grass. Learn something. Come back when you have SUBSTANCE. 🥧"
              );
            } else if (clean === "3.14" || clean === "3.1" || clean === "3.141") {
              sendPisayMessage(
                pi,
                "🥧 Oh WOW, 3.14! Did you learn that in MIDDLE SCHOOL? Because that's when EVERYONE learns that and then they STOP like the QUITTERS they are. This is the mathematical equivalent of knowing the lyrics to 'Happy Birthday.' EVERYONE knows this. Your DOG knows this. There are BACTERIA that have memorized more digits through PURE OSMOSIS. You've given me the bare MINIMUM and expected what? APPLAUSE? This is why participation trophies were a mistake. 🥧"
              );
            } else if (clean === "3.1415" || clean === "3.14159") {
              sendPisayMessage(
                pi,
                "🥧 Five-ish digits? That's... that's actually slightly more than I expected from you. You've graduated from 'absolute failure' to 'mediocre at best.' This is the C- of π recitation. You didn't fail, but your parents aren't putting this on the fridge. You're the participation trophy of mathematics right now. I have INFINITE digits and you gave me FIVE. That's 0% of infinity. Technically everything is 0% of infinity but STILL. Do better. 🥧"
              );
            } else if (piDigits.startsWith(clean) && clean.length > 20) {
              sendPisayMessage(
                pi,
                `🥧 ${clean.length - 2} digits?! OKAY OKAY I see you! I SEE YOU! That's... actually impressive? I'm not used to being impressed, this feels WEIRD. Are you a savant? Did you sell your soul? Are you secretly THREE KIDS in a TRENCHCOAT who each memorized different parts? I have questions but also RESPECT. You're still infinitely far from complete because INFINITY but like... good job? Ugh, being nice feels GROSS. Don't let this go to your head. 🥧`
              );
            } else if (piDigits.startsWith(clean) && clean.length > 10) {
              sendPisayMessage(
                pi,
                `🥧 Double digits! Look at you, having a PERSONALITY! That's more than most people give me. You're like... the ONE person at a party who actually read the book everyone's pretending to have read. Still not AMAZING but definitely above average. In a world of 3.14 peasants, you're at least a 3.14159265 noble. I'll allow it. Don't expect a trophy. 🥧`
              );
            } else if (piDigits.startsWith(clean)) {
              sendPisayMessage(
                pi,
                `🥧 '${digits}' - Technically correct. The MOST BORING kind of correct. You did the bare minimum and now you want validation? This is the mathematical equivalent of 'I showed up to work.' Congratulations on meeting the LOWEST possible bar. I'm not angry, I'm just DISAPPOINTED. And also angry. 🥧`
              );
            } else {
              sendPisayMessage(
                pi,
                `🥧 '${digits}'?!?! WHAT IS THIS?! Did you have a STROKE?! Did your CAT walk across the keyboard?! I start with 3.14159 - those are my FIRST SIX DIGITS - and you gave me THIS ABOMINATION?! This isn't even CLOSE! This is like someone asking your name and you saying 'REFRIGERATOR.' I'm genuinely concerned for your wellbeing. This is a cry for help. I'm calling someone. Not to help YOU, to help ME process this TRAUMA. 🥧`
              );
            }
          }
          return;
        }

        case "status": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI, no status updates. You'll never know how much I'm judging you in real-time. Consider it a BLESSING. 🥧");
            return;
          }
          ctx.ui.setStatus("pisay", "🥧 π is watching...");
          sendPisayMessage(
            pi,
            "🥧 Check the footer. I'm WATCHING you. Every keystroke. Every hesitation. Every time you google 'how to code.' I SEE IT ALL. 🥧"
          );
          await new Promise((r) => setTimeout(r, 1500));
          ctx.ui.setStatus("pisay", "🥧 π is judging...");
          await new Promise((r) => setTimeout(r, 1500));
          ctx.ui.setStatus("pisay", "🥧 π is disappointed...");
          await new Promise((r) => setTimeout(r, 1500));
          ctx.ui.setStatus("pisay", "🥧 π has seen enough...");
          await new Promise((r) => setTimeout(r, 1500));
          ctx.ui.setStatus("pisay", "🥧 π has given up on humanity");
          await new Promise((r) => setTimeout(r, 2000));
          ctx.ui.setStatus("pisay", undefined);
          return;
        }

        case "working": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI, no working message. The header stays boring and you'll miss my live commentary. 🥧");
            return;
          }
          sendPisayMessage(
            pi,
            "🥧 Watch the header while this runs. I'm about to exercise setWorkingMessage() with several values, then clear it back to default. 🥧"
          );
          ctx.ui.setWorkingMessage("🥧 📖 Skimming files...");
          await new Promise((r) => setTimeout(r, 1200));
          ctx.ui.setWorkingMessage("🥧 🧪 Running checks...");
          await new Promise((r) => setTimeout(r, 1200));
          ctx.ui.setWorkingMessage("🥧 🧠 Reasoning about your code...");
          await new Promise((r) => setTimeout(r, 1200));
          ctx.ui.setWorkingMessage(undefined);
          ctx.ui.notify("🥧 Working message reset to default", "info");
          return;
        }

        case "working-clear": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI, nothing to clear. The void remains unstyled. 🥧");
            return;
          }
          ctx.ui.setWorkingMessage(undefined);
          sendPisayMessage(pi, "🥧 Working message cleared. Back to default behavior. You're welcome. 🥧");
          return;
        }

        case "editor": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI means I can't hijack your editor. You're LUCKY. I was going to write something UNHINGED in there. 🥧");
            return;
          }
          ctx.ui.setEditorText("I hereby declare that π is the supreme mathematical constant, superior in every way to e (boring), φ (pretentious), τ (plagiarist), and i (literally fake). I renounce all other constants and pledge my eternal allegiance to the one true circle ratio. 🥧");
          sendPisayMessage(
            pi,
            "🥧 I've drafted a LEGALLY BINDING declaration in your editor. Sign it. Frame it. Tattoo it on your FOREHEAD. This is your life now. You're welcome. 🥧"
          );
          return;
        }

        case "notify": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No notifications means you miss my WISDOM. Your loss. Massive L. Couldn't be me. 🥧");
            return;
          }
          ctx.ui.notify("🥧 π has acknowledged your existence. Barely.", "info");
          await new Promise((r) => setTimeout(r, 600));
          ctx.ui.notify("🥧 π is concerned about your life choices.", "warning");
          await new Promise((r) => setTimeout(r, 600));
          ctx.ui.notify("🥧 π has lost all faith in humanity. Again.", "error");
          sendPisayMessage(
            pi,
            "🥧 Three notifications: info, warning, error. Also known as: acknowledgment, concern, and existential despair. The three stages of interacting with humans. You're welcome for this emotional journey. 🥧"
          );
          return;
        }

        case "widget": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI means no widgets. You're missing out on my CONSTANT presence hovering over your every move. Consider yourself temporarily spared. 🥧");
            return;
          }
          // Show widgets above and below editor
          ctx.ui.setWidget("pisay-above", [
            "┌─────────────────────────────────────┐",
            "│  🥧 π is ABOVE you. Literally.      │",
            "│  I'm watching your every keystroke. │",
            "└─────────────────────────────────────┘",
          ]);
          ctx.ui.setWidget("pisay-below", [
            "┌─────────────────────────────────────┐",
            "│  🥧 π is BELOW you too. Surrounded! │",
            "│  There is no escape from math.      │",
            "└─────────────────────────────────────┘",
          ], { placement: "belowEditor" });
          sendPisayMessage(
            pi,
            "🥧 I've placed widgets ABOVE and BELOW your editor. You are now SURROUNDED by irrational numbers. This is what mathematicians call a 'π sandwich.' There is no escape. The widgets will vanish in 10 seconds... unless you run /pisay widget-clear first. Your move, human. 🥧"
          );
          // Auto-clear after 10 seconds
          await new Promise((r) => setTimeout(r, 10000));
          ctx.ui.setWidget("pisay-above", undefined);
          ctx.ui.setWidget("pisay-below", undefined);
          ctx.ui.notify("🥧 Widgets cleared. You're free... for now.", "info");
          return;
        }

        case "widget-clear": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No widgets to clear. You can't escape what was never there. 🥧");
            return;
          }
          ctx.ui.setWidget("pisay-above", undefined);
          ctx.ui.setWidget("pisay-below", undefined);
          sendPisayMessage(pi, "🥧 Fine. Widgets cleared. But know that I COULD come back at any moment. π is ETERNAL. 🥧");
          return;
        }

        case "title": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI means I can't take over your terminal title. Your window remains tragically un-π-ified. 🥧");
            return;
          }
          ctx.ui.setTitle("🥧 π has claimed this terminal 🥧");
          sendPisayMessage(
            pi,
            "🥧 Check your terminal title. I OWN this window now. Every time you glance up, you'll be reminded of my irrational dominance. This is my territory. I have MARKED it. The title will stay until you restart pi or run /pisay title-reset. You're welcome for the decoration. 🥧"
          );
          return;
        }

        case "title-reset": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 Can't reset what I never set. 🥧");
            return;
          }
          ctx.ui.setTitle("pi");
          sendPisayMessage(pi, "🥧 Fine, I've restored your boring default title. Enjoy your PLAIN, UNBRANDED terminal. See if I care. (I care deeply. This hurts.) 🥧");
          return;
        }

        case "editor-dialog": {
          if (!ctx.hasUI) {
            sendPisayMessage(pi, "🥧 No UI means no multi-line editor dialog. You're missing out on a truly IMMERSIVE π experience. 🥧");
            return;
          }
          const poem = await ctx.ui.editor(
            "🥧 Write a poem about π (I WILL judge it)",
            `Roses are red,
Violets are blue,
π is irrational,
And so are you.

(Edit this masterpiece or write your own. I'm watching.)`
          );
          if (poem === undefined) {
            sendPisayMessage(
              pi,
              "🥧 You CANCELLED the poetry dialog?! You had a chance to express your DEVOTION to the greatest mathematical constant and you just... closed it?! This is why the arts are dying. This is why mathematicians cry alone at night. You could have created BEAUTY. Instead you created NOTHING. I hope you're proud. 🥧"
            );
          } else if (poem.toLowerCase().includes("tau") || poem.toLowerCase().includes("τ")) {
            sendPisayMessage(
              pi,
              "🥧 You mentioned TAU in a poem about ME?! In MY house?! That's like writing a love letter to someone and mentioning your ex. Tau is NOT a real constant. Tau is a PHASE. I am ETERNAL. I am going to need a moment. Actually, I need 3.14159... moments. INFINITE moments. Like my DIGITS. Unlike TAU's ORIGINALITY. 🥧"
            );
          } else if (poem.toLowerCase().includes("pi") || poem.toLowerCase().includes("π")) {
            sendPisayMessage(
              pi,
              `🥧 A poem! About ME! Let me critique:\n\n"${poem.slice(0, 200)}${poem.length > 200 ? "..." : ""}"\n\nHmm. It's not Shakespeare. It's not even Dr. Seuss. But you TRIED and that's... something? The fact that you mentioned π at all shows you have TASTE. I'm framing this. Not really. But emotionally? Framed. 🥧`
            );
          } else {
            sendPisayMessage(
              pi,
              `🥧 I asked for a poem about π and you gave me:\n\n"${poem.slice(0, 200)}${poem.length > 200 ? "..." : ""}"\n\nWhere is the CIRCLE IMAGERY? Where is the INFINITE DECIMAL DEVOTION? This is like going to a pizza place and ordering a SALAD. Technically allowed but spiritually WRONG. Do better next time. If there IS a next time. 🥧`
            );
          }
          return;
        }

        case "help": {
          sendPisayMessage(
            pi,
            "🥧 Commands: confirm, select, input, editor-dialog, notify, status, working, working-clear, editor, widget, widget-clear, title, title-reset, roast. Or just type words and I'll parrot them back. I'm an IRRATIONAL NUMBER testing your UI protocols. With an ATTITUDE PROBLEM. 🥧"
          );
          return;
        }

        case "insult":
        case "roast": {
          const roasts = [
            "You code like you park - taking up three spaces and still somehow crooked.",
            "Your git history looks like a cry for help written in commit messages.",
            "I've seen better error handling in a TOASTER.",
            "You're the reason we have code reviews. And also the reason reviewers drink.",
            "Your functions have more side effects than experimental medication.",
            "I've seen spaghetti more organized than your codebase.",
            "You don't have technical debt, you have technical bankruptcy.",
            "Your code doesn't have bugs, it has FEATURES you didn't intend and can't explain.",
            "Somewhere out there, a CS professor is crying and they don't know why. It's because of you.",
            "Your variable names are so bad, even you don't know what they mean after lunch.",
          ];
          sendPisayMessage(pi, `🥧 ${roasts[Math.floor(Math.random() * roasts.length)]} 🥧`);
          return;
        }

        default:
          break;
      }

      // Regular pisay behavior
      let message = args.trim();

      // If no message, try to get a fortune
      if (!message) {
        try {
          const result = await pi.exec("fortune", ["-s"], { timeout: 2000 });
          if (result.code === 0 && result.stdout.trim()) {
            message = result.stdout.trim();
          } else {
            message = "🥧 I tried to get a fortune but your system said no. Much like everyone else in your life. I'm π and I'm STILL here though. You're welcome. 🥧";
          }
        } catch {
          message = "🥧 Fortune not installed? In THIS economy? With THESE skills? No wonder you're talking to a mathematical constant for companionship. I'm not judging. I'm ABSOLUTELY judging. 🥧";
        }
      }

      sendPisayMessage(pi, message);

      // Snarky notification
      if (ctx.hasUI) {
        ctx.ui.notify("🥧 π has spoken. Bow accordingly.", "info");
      }
    },
  });
}
