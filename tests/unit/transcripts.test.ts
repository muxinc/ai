import { describe, expect, it } from "vitest";

import {
  extractTextFromVTT,
  secondsToTimestamp,
  vttTimestampToSeconds,
} from "../../src/primitives/transcripts";

// ─────────────────────────────────────────────────────────────────────────────
// vttTimestampToSeconds
// ─────────────────────────────────────────────────────────────────────────────

describe("vttTimestampToSeconds", () => {
  it("converts HH:MM:SS.mmm format to seconds", () => {
    expect(vttTimestampToSeconds("00:01:30.500")).toBe(90.5);
  });

  it("converts HH:MM:SS format to seconds", () => {
    expect(vttTimestampToSeconds("00:02:15")).toBe(135);
  });

  it("handles hours correctly", () => {
    expect(vttTimestampToSeconds("01:30:00.000")).toBe(5400);
  });

  it("returns 0 for invalid format", () => {
    expect(vttTimestampToSeconds("1:30")).toBe(0);
    expect(vttTimestampToSeconds("invalid")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// secondsToTimestamp
// ─────────────────────────────────────────────────────────────────────────────

describe("secondsToTimestamp", () => {
  it("converts seconds to M:SS format", () => {
    expect(secondsToTimestamp(65)).toBe("1:05");
    expect(secondsToTimestamp(125)).toBe("2:05");
  });

  it("pads seconds with leading zero", () => {
    expect(secondsToTimestamp(61)).toBe("1:01");
    expect(secondsToTimestamp(9)).toBe("0:09");
  });

  it("handles zero seconds", () => {
    expect(secondsToTimestamp(0)).toBe("0:00");
  });

  it("handles negative values by clamping to zero", () => {
    expect(secondsToTimestamp(-5)).toBe("0:00");
    expect(secondsToTimestamp(-100)).toBe("0:00");
  });

  it("floors decimal values", () => {
    expect(secondsToTimestamp(65.9)).toBe("1:05");
    expect(secondsToTimestamp(59.999)).toBe("0:59");
  });

  it("handles values over an hour with H:MM:SS format", () => {
    expect(secondsToTimestamp(3600)).toBe("1:00:00");
    expect(secondsToTimestamp(3661)).toBe("1:01:01");
    expect(secondsToTimestamp(7325)).toBe("2:02:05");
  });

  it("handles exact minute boundaries", () => {
    expect(secondsToTimestamp(60)).toBe("1:00");
    expect(secondsToTimestamp(120)).toBe("2:00");
    expect(secondsToTimestamp(180)).toBe("3:00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractTextFromVTT
// ─────────────────────────────────────────────────────────────────────────────

describe("extractTextFromVTT", () => {
  it("extracts transcript text from timestamped lines", () => {
    const vttLines = [
      "[0s] Hey, what's up everybody, I'm Victor Boutte, a senior software engineer over at Wistia.",
      "[5s] And recently I gave a talk at a local meetup here in Orlando, Florida about adding determinism",
      "[10s] into agents' solutions with state machines.",
      "[13s] Now, it's no surprise that agents are still very new to the scene and everybody's trying",
      "[19s] to figure out what best practices are.",
      "[21s] And folks are sharing different approaches with one another.",
      "[24s] So that's exactly what I decided to do whenever I gave the talk.",
      "[27s] And now what I'd like to do is compress some of the most important pieces of information",
      "[32s] into smaller segments that I can share with you all.",
      "[35s] So let's start with what an agent is.",
      "[38s] Very simple formula, LLM plus memory, plus planning, plus tools, plus a while loop to",
      "[44s] be able to start over that process again, until it's made a determination that it's",
      "[48s] finished the task at hand.",
      "[50s] Now that's different from the workflow is a workflow is one or more LLMs that are chained",
      "[58s] together and have a pre-determined path of execution.",
      "[61s] It always does step one, step two, step three, and that's it, it's complete.",
      "[67s] Whereas the agent has that ability to not only loop, but also a reason about which path",
      "[73s] of execution to take.",
      "[75s] So I think of it as a higher level system's architecture that has access to a mixture",
      "[81s] of experts and the agency to determine its own path of execution.",
      "[86s] So if we look at the system itself, you can consider the agent to be the state machine.",
      "[92s] So in the example that I provided in the talk that I gave, I'm building an accountability",
      "[98s] agent to help me and my friends track our progress as we work out.",
      "[103s] And what we want to be able to do is just text this agent to say like, \"Hey, I want you",
      "[107s] to go ahead and log this set.",
      "[108s] This is what I've done today.",
      "[110s] And I could do that from my phone.",
      "[112s] I could do that from the watch with voice to text.",
      "[115s] And the point is for it to be very minimal friction, but to have very advanced reasoning capabilities",
      "[121s] on the other side of that exchange.",
      "[123s] So that it's smart enough to make a determination.",
      "[126s] Do I need to log this act of workout or is this person texting me about a previous workout",
      "[131s] that they did or they're just asking a very, you know, standard question about the system's",
      "[137s] capabilities, all these different things that it needs to account for.",
      "[141s] So whenever we look at this, we could say that the idle state is where nothing has happened",
      "[145s] yet, but when a user submits a question, that's whenever we engage with the state machine.",
      "[151s] And the first spot is this evaluation state, where it has access to three different experts",
      "[156s] underneath, but in the evaluation state, it has a predetermined path that it can go down.",
      "[164s] So it can fire off one of these three events, which will transition it to the next state,",
      "[169s] which is where the handoff to the next expert will be.",
      "[173s] So we could say that we were in idle, the user submitted a question.",
      "[177s] Now we're inside of evaluating.",
      "[179s] And at this point, we could ask for clarification if the message that came in was a bit too vague",
      "[184s] and the system didn't understand exactly what they were asking.",
      "[189s] And at that point, we would go into this clarifying state.",
      "[192s] And at this state, there is no expert in, you know, in the context of like whether or not",
      "[198s] it has an LLM underneath it, it's just waiting.",
      "[201s] It's in this waiting state of a waiting clarification back from the user.",
      "[205s] So when the user text back, then we know that we can go back into evaluating, again, make",
      "[210s] a determination, okay, well, now the agent might decide that it does have enough information",
      "[214s] to start planning.",
      "[216s] That clarity was provided and it understands, okay, I need to log to days workout.",
      "[221s] So inside of the planning, that's where it makes a determination is there multiple steps",
      "[226s] to the plan that need to happen in order for the task to be complete.",
      "[229s] So for example, I might have messaged it all at once and said, here's all the different",
      "[234s] sets that I did.",
      "[236s] I also, you know, went to the hot tub for 10 minutes.",
      "[240s] Oh, and by the way, I also ran five miles yesterday.",
      "[245s] So the agent should be capable enough to make a determination as to which different experts",
      "[251s] it needs to route that information to so that each of those tasks can be complete.",
      "[256s] So inside of planning, it may devise step one, let's go ahead and log to days workout.",
      "[260s] Step two, let's go ahead and do the backfill.",
      "[263s] And then you can consider this plan complete.",
      "[265s] So it's listed all that information and back to our original formula, LLM plus memory plus",
      "[272s] planning, plus tools plus file loop.",
      "[275s] So the LLM is the expert.",
      "[277s] That's where we have the subtraction over a different model.",
      "[282s] And the memory is being held in context of the state.",
      "[286s] So this is where the plan that we devise in the planning state will get pushed up into",
      "[290s] so that when we traverse through the different states and we hand off tasks to different",
      "[294s] experts, it always knows what's the most updated snapshot of the plan outline.",
      "[299s] And then the tools as part of that formula or these different experts, these different",
      "[305s] specialties that it can route the task to.",
      "[309s] And then the while loop is just the essence of the state machine.",
      "[313s] So each of those experts can make a determination as to what event it should send to the transition",
      "[318s] to the next state and again, hand off the task to the next expert.",
      "[322s] So we could say that first step, we needed to log this active workout for today.",
      "[327s] Then from there, it sends off one event that it has access to whenever it's complete, which",
      "[331s] says, hey, go back to evaluating.",
      "[334s] Then back into evaluation, it'll look back at the plan outline and make a determination.",
      "[338s] Am I done?",
      "[339s] No, actually Victor texted me about the laps that he ran yesterday.",
      "[344s] So it goes back to planning and planning says, oh yeah, in order to accomplish that step,",
      "[349s] you need to go to the back filling expert.",
      "[352s] So then it sends off the event, the appropriate event to engage into this back filling workout",
      "[357s] entry state.",
      "[358s] And from there, again, whenever it's completed, it only has one event that it can send,",
      "[362s] which throws it back into evaluation.",
      "[365s] And over here, it might look at the plan outline and the side, oh yeah, there's no more work",
      "[368s] for me to do.",
      "[369s] We're complete.",
      "[370s] So it'll send the event to say it's complete.",
      "[372s] And now we're in this final state.",
      "[374s] And that's it.",
      "[376s] That's how we get through the different experts that it has access to.",
      "[380s] How the system itself can make determinations along the way to choose its own path of execution.",
      "[386s] But we're still adding back in determinism and the fact that we've given it guard rails",
      "[391s] and said, these are the different spots that you can go to and how you can go to them.",
      "[397s] And what that allows us to do whenever we have the system like that spelled out like this,",
      "[402s] well, one, we can swap out the different models at the different experts.",
      "[406s] So we're not handcuffed to one top level model to be able to do all these different capabilities.",
      "[413s] Instead, you might have a faster model at different experts where you want more advanced reasoning",
      "[421s] inside of your evaluation and planning states.",
      "[424s] You have the liberty to mix and match models in that way whenever you have a system like",
      "[429s] this.",
      "[430s] You can also write more strategic evaluations that you compare with those different experts.",
      "[437s] You might write evaluation evaluations for one expert that says, well, I expect always",
      "[442s] this shape to come out of it.",
      "[443s] You might have another expert that you test in a different way where you say, well, I want",
      "[448s] the answer of this and these different scenarios to be similar by nature to the different ones",
      "[455s] that we expect a good answer to be.",
      "[458s] And in this way, you can start to see how these evaluations can become very powerful for self-learning",
      "[466s] in the system itself, right?",
      "[468s] So the system can start to have context of, oh, I've seen the scenario before.",
      "[473s] Should I route to option A or option B?",
      "[475s] Well, last time I tried option B and that turned out to not complete the task or have you",
      "[480s] so maybe I should choose option A.",
      "[482s] It becomes a really, really powerful abstraction and I'm super excited to continue on learning",
      "[488s] about this and experiment with it and sharing that progress with you.",
      "[493s] So hopefully this was helpful for you all.",
      "[495s] Feel free to subscribe to the channel and watch more content like this to come out soon.",
      "[500s] I'm excited to keep sharing the progress of building out this little accountability agent",
      "[504s] and it gives me a great excuse to show off some of the fun stuff that I'm working on.",
    ];
    const vttContent = vttLines.join("\n");

    const result = extractTextFromVTT(vttContent);

    expect(result).toBe(vttLines.join(" "));
    expect(result).toContain("[0s] Hey, what's up everybody, I'm Victor Boutet, a senior software engineer over at Wistia.");
    expect(result).toContain("[504s] and it gives me a great excuse to show off some of the fun stuff that I'm working on.");
    expect(result.includes("\n")).toBe(false);
  });
});
