# The API contract, as verified

The request shape is documented. The response shape was described only in prose
and blog samples, so it was checked against the live endpoint instead of assumed
— and that check turned up a bug, which is the argument for doing it.

- **A score's levels go out as an ordered list, not a map.** A map is refused
  with HTTP 422 before a single token is spent. `jev_gate` asks for a score on
  every ambiguous action, so this was the difference between a gate that
  classifies and one that could only ever report that its classifier was
  unreachable. Choice and Noul do take a map, which is why the conversion lives
  in one place (`serialiseQuestion`).
- **`score` is a position on the level number line, not a level.** It is each
  level number multiplied by its probability, so 0.57 on level 1 plus 0.43 on
  level 2 comes back as 1.43. pi-jev reports the level the distribution peaks
  on — under the name you gave it, if you named your levels — together with that
  level's own probability, which is the quantity calibration is computed over.
- **`usage` is `input_tokens` / `output_tokens`, and a Noul answer arrives under
  `noul`.** Those are read as they come; the parser still accepts the other
  spellings for compatible endpoints.

What has not changed is the failure mode. When a probability cannot be read, the
answer is recorded `degraded` with `p=0.5` and the raw body is kept, rather than a
confidence being invented. Nothing downstream depends on a guess.
