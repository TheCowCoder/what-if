# Recent Implementation History

This file summarizes the most recent implemented changes so test planning can target the highest-risk areas first.

1. Repelled minimap labels were added so markers no longer stack directly on top of each other.
2. The main settings UI was split into paged sections.
3. A Debug settings page was added.
4. Unlimited turn time was wired into PvP arena rooms.
5. Unlimited turn time was wired into bot matches.
6. Non-exploration arena fights now use room-backed battle map state.
7. Bot fights now use the same battle map state foundation.
8. Arena matches now begin with a preparation flow before battle.
9. The preparation flow includes a profile review phase.
10. The preparation flow includes a one-pass rewrite phase before battle.
11. Avatar/profile inspection is available from the circular prep avatars.
12. The prep inspect modal closes automatically when the review stage ends.
13. Opponent profiles are no longer reopenable during the write phase.
14. Room-scoped typing indicators were added for arena prep and battle.
15. Battle lock-in UI now shows typing status instead of only static state.
16. Exploration target chips now show nearby player typing activity.
17. Bot matches now attempt a prep-phase markdown rewrite before battle.
18. Character sync payloads now strip portrait image data to avoid oversized realtime payloads.
19. MongoDB character sync now preserves existing avatars when stripped character payloads are uploaded.
20. A dedicated avatar upload endpoint was added for authenticated users.
21. Character portraits are compressed client-side before storage and upload.
22. The client now uploads avatars separately from the main character sync payload.
23. Local character state now preserves existing image URLs when stripped sync responses arrive.
24. Automatic portrait generation no longer runs during the arena prep markdown rewrite phase.
25. Saving a character during arena prep now locks that player in.
26. A Pass button was added to the arena prep rewrite phase.
27. Arena prep typing indicators were moved below avatars instead of rendering inside them.
28. Arena prep indicators now switch to a checkmark with Locked in text when a player finishes.
29. Bot prep completion now uses the same locked-in state shown for human players.
30. NPC allies are auto-locked when the tweak phase begins.
31. Arena movement updates are now visible through shared battle movement logs.
32. Battle prompts now include map-distance context so chase and flee logic can affect outcomes.
33. Bot action prompts now include battle-map context as well.
34. Battle prompts now include exact x/y coordinates for current fighter positions.
35. Battle prompts now explicitly describe water traversal as valid movement between islands.
36. The judge tool contract now supports returning exact battle position updates per fighter.
37. Client turn resolution now parses judge-authored battle position updates.
38. Client turn resolution now merges those position updates into battle map state.
39. Server turn resolution now sanitizes and persists the resolved battle map state.
40. Resolved battle map state is now rebroadcast to all clients after each judged turn.
41. The battle minimap now centers on live x/y coordinates instead of only the nearest named location.
42. The full-screen battle map now shows an explicit self marker for the local fighter.
43. Mid-route swimming and pursuit movement now remain visible on the minimap from turn to turn.
44. Battle map updates now stay authoritative on the server so positions do not snap back next turn.
45. Arena preview time was shortened from 30 seconds to 15 seconds.
46. Any player can now leave preview early and unlock a local head-start rewrite phase.
47. Once every human player has skipped preview, the whole room advances to the shared rewrite phase immediately.
48. Bot prep rewrite now falls back to locking in the existing profile if rewrite generation fails or returns empty.
49. Local bot typing state now stays visible until the bot actually locks in.
50. Exploration presence updates now merge authoritative server state back into the local exploration state.
51. Avatar generation chat messages can now render inline multi-frame previews when the image model returns progressive frames.
52. The active selected character is now persisted by name so reloads prefer the user’s last explicit legend choice.
53. Character switching no longer rewrites the full character list when the selected legend data is unchanged.
54. Incoming character sync now dedupes against stripped payload data so portrait preservation does not create an infinite selection snap-back loop.
55. Early head-start prep lock-ins now persist when the room later enters the shared tweak phase.
56. Bot matches now grant the bot instant rewrite access during preview so bot typing and bot lock-in can begin immediately.
57. Bot prep typing now survives per-second prep-state refreshes instead of dropping blank before locked-in state arrives.
58. Bot prep rewrites now continue across the preview-to-tweak transition instead of getting cancelled mid-generation.
59. Bot prep now uses a short preview-phase fallback timeout so slow rewrites still lock in during preview.
60. Arena prep now starts the match immediately once every rewrite-capable participant is locked in, even if the room is still in preview.
61. Bot prep saves and bot combat actions now route through the same shared prep-save and player-action helpers used by human PvP flows.
62. Battle resolution now logs judge tool calls live and falls back to a submitted-actions summary when the model returns only thoughts plus a tool call.

Suggested high-priority test areas:

1. Avatar persistence across login, reload, and stripped sync updates.
2. Prep review skip behavior with two human players.
3. Bot prep typing and locked-in behavior during the tweak phase.
4. Water movement, pursuit, and mid-route positioning visibility on the minimap.
5. Cross-client target-button consistency after movement.