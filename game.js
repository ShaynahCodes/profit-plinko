/* =========================================================
   PROFIT PLINKO — AlignedFX
   ========================================================= */

(function () {
  "use strict";

  function boot() {
    const plinkoWrapper = document.getElementById("plinko-wrapper");
    const menuLayer = document.getElementById("plinko-menu-layer");
    const startBtn = document.getElementById("plinko-start-btn");
    const menuTitle = document.getElementById("plinko-menu-title");
    const menuDesc = document.getElementById("plinko-menu-desc");
    const flashOverlay = document.getElementById("flash-overlay");

    const cvs = document.getElementById("gameCanvas");
    const bgCvs = document.getElementById("bgCanvas");

    if (!plinkoWrapper || !cvs || !bgCvs || !startBtn || !menuLayer) return;

    const ctx = cvs.getContext("2d");
    const bgCtx = bgCvs.getContext("2d");
    if (!ctx || !bgCtx) return;

    const uiScore = document.getElementById("ui-score");
    const uiPegs = document.getElementById("ui-pegs");
    const uiBalls = document.getElementById("ui-balls");
    const uiMult = document.getElementById("ui-mult");
    const hudEl = document.querySelector(".plinko-hud-container");

    // Respect the OS "reduce motion" setting: no white flash, no screen shake.
    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // =======================
    // GAME STATE
    // =======================
    let width = 0;
    let height = 0;
    let prevWidth = 0;
    let prevHeight = 0;
    let isGameRunning = false;
    let animationId = null;

    // Fixed timestep: physics always advances at 60 steps per second, however
    // fast the screen refreshes. Before this, a 120Hz or 144Hz display ran the
    // whole game 2-2.4x faster.
    const STEP_MS = 1000 / 60;
    let lastTime = 0;
    let accumulator = 0;

    // The vertical band the peg field occupies, between the cannon and the
    // bucket. Kept so a resize can remap pegs into the new band.
    let board = { top: 0, bottom: 0 };

    // Set when the screen rotates while a ball is in flight; the board is
    // rebuilt as soon as the shot finishes.
    let pendingRebuild = false;

    // Menu flow is tracked by state rather than button text, so the
    // wording can change without affecting round progression.
    let menuMode = "new"; // "new" | "next" | "retry"

    const CFG = {
      gravity: 0.25,
      friction: 0.99,
      wallBounce: 0.7,
      ballRadius: 7,
      pegRadius: 8,
      maxMultiplier: 20,
      ballMaxAge: 60 * 30, // failsafe: ~30s at 60fps
      launchSpeed: 12,
      bucketClearance: 110, // empty space kept between last peg row and bucket
      rowGapMax: 38,
      rowGapMin: 24,
      slowMoRange: 100, // how close the ball gets before time slows
      slowMoZoom: 2.2,
      aimSteps: 70, // max frames of flight the aim preview simulates
      colors: {
        ball: "#F0E8D7",
        green: "#919B81",
        gold: "#D4AF37",
        purple: "#C4826C",
        bucket: "#7c8a76"
      }
    };

    const state = {
      score: 0,
      balls: 10,
      level: 1,
      multiplier: 1,
      pegsLeft: 0,
      aiming: true,
      shake: 0,
      timeScale: 1.0
    };

    const camera = { x: 0, y: 0, zoom: 1.0 };
    const cannon = { x: 0, y: 0, angle: Math.PI / 2 };
    const bucket = { x: 0, y: 0, w: 90, h: 35, dir: 1, speed: 3 };

    let balls = [];
    let pegs = [];
    let particles = [];
    let floats = [];
    let candles = [];

    // =======================
    // AUDIO
    // =======================
    let audioCtx = null;
    let masterGain = null;

    function initAudio() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;

        if (!audioCtx) {
          audioCtx = new AC();
          masterGain = audioCtx.createGain();
          masterGain.gain.value = 0.2;
          masterGain.connect(audioCtx.destination);
        }

        if (audioCtx.state === "suspended") audioCtx.resume();
      } catch (e) {
        audioCtx = null;
      }
    }

    function sfx(type) {
      if (!audioCtx || audioCtx.state !== "running") return;

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();

      osc.connect(g);
      g.connect(masterGain);

      if (type === "hit") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(300 + Math.random() * 100, now);
        osc.frequency.exponentialRampToValueAtTime(0.01, now + 0.1);
        g.gain.setValueAtTime(0.3, now);
        g.gain.linearRampToValueAtTime(0, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (type === "gold") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.linearRampToValueAtTime(1046.5, now + 0.2);
        g.gain.setValueAtTime(0.3, now);
        g.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === "bonus") {
        // Deliberately unlike the gold chime: a bright stepped blip so a
        // bonus trade is audibly distinct from clearing a target.
        osc.type = "square";
        osc.frequency.setValueAtTime(392, now);
        osc.frequency.setValueAtTime(523.25, now + 0.07);
        osc.frequency.setValueAtTime(698.46, now + 0.14);
        g.gain.setValueAtTime(0.16, now);
        g.gain.setValueAtTime(0.16, now + 0.2);
        g.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === "shoot") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(10, now + 0.15);
        g.gain.setValueAtTime(0.2, now);
        g.gain.linearRampToValueAtTime(0, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (type === "recover") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.linearRampToValueAtTime(1600, now + 0.1);
        // exponentialRampToValueAtTime needs a non-zero start and end value.
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.4, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      } else if (type === "liquidated") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.linearRampToValueAtTime(40, now + 0.5);
        g.gain.setValueAtTime(0.3, now);
        g.gain.linearRampToValueAtTime(0, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.5);
      }
    }

    // =======================
    // RESIZE
    // =======================
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = plinkoWrapper.getBoundingClientRect();

      const newWidth = Math.max(1, rect.width);
      const newHeight = Math.max(1, rect.height);

      const hadSize = prevWidth > 0 && prevHeight > 0;
      const flipped =
        hadSize && prevWidth > prevHeight !== newWidth > newHeight;
      const sx = hadSize ? newWidth / prevWidth : 1;
      const sy = hadSize ? newHeight / prevHeight : 1;
      const oldBoard = { top: board.top, bottom: board.bottom };

      cvs.width = Math.round(newWidth * dpr);
      cvs.height = Math.round(newHeight * dpr);
      bgCvs.width = Math.round(newWidth * dpr);
      bgCvs.height = Math.round(newHeight * dpr);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      width = newWidth;
      height = newHeight;
      prevWidth = newWidth;
      prevHeight = newHeight;

      // Place the cannon just below the HUD, whatever height the HUD ends up.
      const hudBottom = hudEl
        ? hudEl.getBoundingClientRect().bottom - rect.top
        : 70;
      cannon.x = width / 2;
      cannon.y = Math.max(30, hudBottom + 16);

      bucket.y = height - 60;
      bucket.w = Math.max(60, Math.min(120, width * 0.18));
      bucket.x = Math.max(0, Math.min(bucket.x, width - bucket.w));

      camera.x = width / 2;
      camera.y = height / 2;

      // On resize or rotation, remap pegs into the new board band (between
      // the HUD and the bucket) so rows stay clear of both.
      const newBoard = boardBand();
      const oldSpan = oldBoard.bottom - oldBoard.top;

      if (hadSize && oldSpan > 0) {
        const k = (newBoard.bottom - newBoard.top) / oldSpan;

        pegs.forEach(function (p) {
          p.x *= sx;
          p.y = newBoard.top + (p.y - oldBoard.top) * k;
        });

        balls.forEach(function (b) {
          b.x *= sx;
          b.y *= sy;
        });
      }

      board = newBoard;

      // A rotation changes which spots a shot can reach, so gold could end up
      // somewhere impossible. Rebuild the board (keeping score, trades and the
      // number of gold left). Never mid-shot: wait until the ball is done.
      if (flipped && isGameRunning) {
        if (state.aiming && balls.length === 0) {
          rebuildBoard();
        } else {
          pendingRebuild = true;
        }
      }

      buildCandles();
    }

    function boardBand() {
      const top = Math.max(120, cannon.y + 70);
      const room = Math.max(0, bucket.y - top);

      // Tall screens keep the full 110px gap above the bucket. Short screens
      // (a phone in landscape) shrink the gap instead of letting the bottom
      // row sit on top of the bucket.
      const clearance = Math.min(CFG.bucketClearance, room * 0.4);
      const bottom = top + Math.max(60, room - clearance);

      return { top: top, bottom: bottom };
    }

    function rebuildBoard() {
      pendingRebuild = false;

      const goldLeft = pegs.filter(function (p) {
        return p.type === "gold" && !p.hit;
      }).length;

      if (goldLeft > 0) {
        generatePegs(state.level, goldLeft);
        updateUI();
      }
    }

    function buildCandles() {
      candles = [];
      let x = 0;

      while (x < width) {
        const w = 10 + Math.random() * 25;

        candles.push({
          x: x,
          y: height / 2 + (Math.random() - 0.5) * height * 0.3,
          w: w,
          h: 20 + Math.random() * 80,
          speed: 0.3 + Math.random() * 0.3,
          green: Math.random() > 0.45
        });

        x += w + 5;
      }
    }

    // =======================
    // MENU
    // =======================
    startBtn.addEventListener("click", function () {
      initAudio();

      menuLayer.style.opacity = "0";
      window.setTimeout(function () {
        menuLayer.style.display = "none";
      }, 300);

      if (menuMode === "next") {
        startLevel(state.level);
      } else {
        startGame();
      }
    });

    function showMenu(title, desc, btnText, mode) {
      isGameRunning = false;
      pendingRebuild = false;
      plinkoWrapper.classList.remove("is-playing");

      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }

      menuMode = mode;

      menuLayer.style.display = "flex";
      window.setTimeout(function () {
        menuLayer.style.opacity = "1";
      }, 10);

      menuTitle.textContent = title;
      menuTitle.style.color =
        mode === "next"
          ? CFG.colors.gold
          : mode === "retry"
          ? CFG.colors.purple
          : CFG.colors.green;

      menuDesc.textContent = desc;
      startBtn.textContent = btnText;
    }

    function startGame() {
      state.score = 0;
      state.balls = 10;
      state.level = 1;
      startLevel(1);
    }

    function startLevel(level) {
      resize();

      isGameRunning = true;
      pendingRebuild = false;
      plinkoWrapper.classList.add("is-playing");
      state.aiming = true;
      state.timeScale = 1;
      state.shake = 0;
      state.balls = 10;

      // Reset the combo multiplier at the start of each round.
      state.multiplier = 1;

      balls = [];
      particles = [];
      floats = [];

      camera.zoom = 1;
      camera.x = width / 2;
      camera.y = height / 2;

      generatePegs(level);
      updateUI();

      if (animationId) cancelAnimationFrame(animationId);
      lastTime = 0;
      accumulator = 0;
      animationId = requestAnimationFrame(loop);
    }

    // =======================
    // PEG GENERATION
    // =======================
    // goldOverride: when the board is rebuilt after a rotation, place exactly
    // the number of gold the player still had left instead of a fresh set.
    function generatePegs(level, goldOverride) {
      pegs = [];

      board = boardBand();
      const topY = board.top;
      const usable = board.bottom - board.top;

      // Rows keep the original 38px spacing until the board runs out of room,
      // then tighten rather than growing down into the bucket.
      const maxRows = Math.floor(usable / CFG.rowGapMin) + 1;
      const rows = Math.min(9 + level, maxRows);
      const rowGap =
        rows > 1 ? Math.min(CFG.rowGapMax, usable / (rows - 1)) : 0;

      const spacing = Math.max(36, Math.min(48, width / 8));
      const cols = Math.max(3, Math.floor((width - 24) / spacing) + 1);
      const edge = CFG.pegRadius + CFG.ballRadius + 2;

      for (let r = 0; r < rows; r++) {
        const rowCols = cols - (r % 2);
        const rowWidth = (rowCols - 1) * spacing;
        const offsetX = (width - rowWidth) / 2;

        for (let c = 0; c < rowCols; c++) {
          const px = offsetX + c * spacing;

          if (px < edge || px > width - edge) continue;
          if (Math.random() > 0.9) continue;

          pegs.push({
            x: px,
            y: topY + r * rowGap,
            r: CFG.pegRadius,
            type: Math.random() < 0.04 ? "purple" : "green",
            hit: false,
            scale: 1
          });
        }
      }

      // Gold can only go where a shot can actually get to. On wide screens the
      // upper corners sit outside every possible trajectory, and gold landing
      // there used to make a level impossible to finish.
      const reach = reachableSet();

      let candidates = pegs.filter(function (p) {
        return p.type === "green" && isReachable(p, reach);
      });

      if (candidates.length < 6) {
        candidates = pegs.filter(function (p) {
          return p.type === "green";
        });
      }

      shuffle(candidates);

      const goldCount =
        typeof goldOverride === "number"
          ? goldOverride
          : Math.min(
              12 + level,
              Math.max(6, Math.floor(candidates.length * 0.3))
            );

      for (let i = 0; i < goldCount && i < candidates.length; i++) {
        candidates[i].type = "gold";
      }
    }

    // Sweep the full range of legal aim angles and collect every point a ball
    // could pass through in free flight. Peg collisions are ignored here: the
    // question is only whether a spot is inside the envelope of possible shots.
    function reachableSet() {
      const R = CFG.ballRadius;
      const points = [];
      const fan = 48;
      const minAngle = Math.asin(0.15);
      const maxAngle = Math.PI - minAngle;

      for (let k = 0; k < fan; k++) {
        const angle = minAngle + ((maxAngle - minAngle) * k) / (fan - 1);

        let x = cannon.x;
        let y = cannon.y;
        let vx = Math.cos(angle) * CFG.launchSpeed;
        let vy = Math.sin(angle) * CFG.launchSpeed;

        for (let i = 0; i < 200; i++) {
          vy += CFG.gravity;
          x += vx;
          y += vy;
          vx *= CFG.friction;
          vy *= CFG.friction;

          if (x < R) {
            x = R;
            vx = Math.abs(vx) * CFG.wallBounce;
          }
          if (x > width - R) {
            x = width - R;
            vx = -Math.abs(vx) * CFG.wallBounce;
          }

          points.push({ x: x, y: y });

          if (y > height) break;
        }
      }

      return points;
    }

    function isReachable(peg, points) {
      const tol = CFG.ballRadius + peg.r + 8;

      for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - peg.x;
        if (dx > tol || dx < -tol) continue;

        const dy = points[i].y - peg.y;
        if (dy > tol || dy < -tol) continue;

        if (dx * dx + dy * dy < tol * tol) return true;
      }

      return false;
    }

    // Fisher-Yates shuffle for an unbiased random order.
    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    }

    // =======================
    // LOOP
    // =======================
    function loop(now) {
      if (!isGameRunning) return;

      animationId = requestAnimationFrame(loop);

      if (!lastTime) lastTime = now;
      // Cap the catch-up so returning to a backgrounded tab doesn't run a
      // burst of physics in one frame.
      accumulator += Math.min(now - lastTime, 100);
      lastTime = now;

      while (accumulator >= STEP_MS) {
        updateCamera();
        updateBucket();
        updateBalls();
        updatePegs();
        updateParticles();
        updateBackground();
        updateShake();
        accumulator -= STEP_MS;
      }

      draw();
      checkGameStatus();
    }

    // =======================
    // CAMERA
    // =======================
    function updateCamera() {
      let targetZoom = 1.0;
      let targetX = width / 2;
      let targetY = height / 2;
      let slowMo = false;

      const goldPegs = pegs.filter(function (p) {
        return p.type === "gold" && !p.hit;
      });

      if (goldPegs.length === 1 && balls.length > 0) {
        const lastPeg = goldPegs[0];

        let minDist = Infinity;
        let closestBall = null;

        balls.forEach(function (b) {
          const dist = Math.hypot(b.x - lastPeg.x, b.y - lastPeg.y);
          if (dist < minDist) {
            minDist = dist;
            closestBall = b;
          }
        });

        if (closestBall && minDist < CFG.slowMoRange) {
          slowMo = true;
          targetZoom = CFG.slowMoZoom;
          targetX = (lastPeg.x + closestBall.x) / 2;
          targetY = (lastPeg.y + closestBall.y) / 2;
        }
      }

      state.timeScale = slowMo ? 0.2 : 1.0;

      camera.zoom += (targetZoom - camera.zoom) * 0.1;
      camera.x += (targetX - camera.x) * 0.1;
      camera.y += (targetY - camera.y) * 0.1;
    }

    // =======================
    // BUCKET
    // =======================
    function updateBucket() {
      bucket.x += bucket.speed * bucket.dir * state.timeScale;

      if (bucket.x <= 0) {
        bucket.x = 0;
        bucket.dir = 1;
      } else if (bucket.x + bucket.w >= width) {
        bucket.x = width - bucket.w;
        bucket.dir = -1;
      }
    }

    // =======================
    // BALL PHYSICS
    // =======================
    function updateBalls() {
      const R = CFG.ballRadius;

      balls.forEach(function (b) {
        if (!b.active) return;

        b.age++;

        b.vy += CFG.gravity * state.timeScale;
        b.x += b.vx * state.timeScale;
        b.y += b.vy * state.timeScale;

        b.vx *= Math.pow(CFG.friction, state.timeScale);
        b.vy *= Math.pow(CFG.friction, state.timeScale);

        if (b.x < R) {
          b.x = R;
          b.vx = Math.abs(b.vx) * CFG.wallBounce;
        }
        if (b.x > width - R) {
          b.x = width - R;
          b.vx = -Math.abs(b.vx) * CFG.wallBounce;
        }

        // Bucket catch
        if (
          b.vy > 0 &&
          b.y > bucket.y &&
          b.y < bucket.y + bucket.h &&
          b.x > bucket.x &&
          b.x < bucket.x + bucket.w
        ) {
          b.active = false;
          state.balls++;
          sfx("recover");

          addFloat(
            bucket.x + bucket.w / 2,
            bucket.y - 20,
            "FREE TRADE",
            CFG.colors.bucket
          );

          updateUI();
          return;
        }

        // Peg collisions
        for (let i = 0; i < pegs.length; i++) {
          const p = pegs[i];
          if (p.hit) continue;

          const dx = b.x - p.x;
          const dy = b.y - p.y;
          const dist = Math.hypot(dx, dy);
          const minDist = R + p.r;

          if (dist >= minDist) continue;

          const angle = dist === 0 ? Math.PI / 2 : Math.atan2(dy, dx);

          // Push the ball clear of the peg so it registers one contact, not two.
          b.x = p.x + Math.cos(angle) * minDist;
          b.y = p.y + Math.sin(angle) * minDist;

          const speed = Math.max(2, Math.hypot(b.vx, b.vy) * 0.85);
          b.vx = Math.cos(angle) * speed;
          b.vy = Math.sin(angle) * speed;

          p.hit = true;
          state.multiplier = Math.min(state.multiplier + 1, CFG.maxMultiplier);

          let pts = 10;
          let col = CFG.colors.green;

          if (p.type === "gold") {
            pts = 100;
            col = CFG.colors.gold;
            if (!reduceMotion) state.shake = 5;
            sfx("gold");

            const goldLeft = pegs.filter(function (pg) {
              return pg.type === "gold" && !pg.hit;
            }).length;

            if (goldLeft === 0) flashScreen();
          } else if (p.type === "purple") {
            pts = 50;
            col = CFG.colors.purple;
            sfx("bonus");

            balls.push({
              x: b.x,
              y: b.y,
              vx: (Math.random() - 0.5) * 8,
              vy: -5,
              age: 0,
              active: true
            });

            addFloat(p.x, p.y, "BONUS TRADE", col, 14);
          } else {
            sfx("hit");
          }

          const finalPts = pts * state.multiplier;
          state.score += finalPts;

          addFloat(p.x, p.y, "+" + finalPts, col);
          spawnParticles(p.x, p.y, col);
          updateUI();
        }

        // Retire balls that leave the board or exceed the age limit, so a
        // stuck ball can't hold the round open.
        if (b.y > height + 20 || b.age > CFG.ballMaxAge) b.active = false;
      });

      balls = balls.filter(function (b) {
        return b.active;
      });
    }

    // =======================
    // PEG SHRINK
    // =======================
    function updatePegs() {
      // Moved out of draw(), which was mutating game state while rendering.
      pegs.forEach(function (p) {
        if (p.hit && p.scale > 0.01) p.scale *= 0.85;
      });
    }

    // =======================
    // BACKGROUND + SHAKE (moved out of draw so they run on the fixed step)
    // =======================
    function updateBackground() {
      candles.forEach(function (c) {
        c.x -= c.speed * state.timeScale;

        if (c.x < -c.w) {
          c.x = width + Math.random() * 50;
          c.green = Math.random() > 0.5;
        }
      });
    }

    function updateShake() {
      if (state.shake > 0) {
        state.shake *= 0.9;
        if (state.shake < 0.5) state.shake = 0;
      }
    }

    // =======================
    // FLASH
    // =======================
    function flashScreen() {
      if (!flashOverlay || reduceMotion) return;

      flashOverlay.style.opacity = "0.6";
      window.setTimeout(function () {
        flashOverlay.style.opacity = "0";
      }, 100);
    }

    // =======================
    // PARTICLES + FLOATS
    // =======================
    function updateParticles() {
      particles.forEach(function (p) {
        p.x += p.vx * state.timeScale;
        p.y += p.vy * state.timeScale;
        p.vy += 0.1 * state.timeScale;
        p.life -= 0.03 * state.timeScale;
      });

      particles = particles.filter(function (p) {
        return p.life > 0;
      });

      floats.forEach(function (f) {
        f.y -= 1 * state.timeScale;
        f.life -= 0.02 * state.timeScale;
      });

      floats = floats.filter(function (f) {
        return f.life > 0;
      });
    }

    // =======================
    // DRAW
    // =======================
    function draw() {
      bgCtx.clearRect(0, 0, width, height);
      ctx.clearRect(0, 0, width, height);

      // --- BACKGROUND CANDLES ---
      bgCtx.globalAlpha = 0.1;

      candles.forEach(function (c) {
        bgCtx.fillStyle = c.green ? CFG.colors.green : CFG.colors.purple;
        bgCtx.fillRect(c.x, c.y - c.h / 2, c.w, c.h);
        bgCtx.fillRect(c.x + c.w / 2 - 1, c.y - c.h / 2 - 10, 2, c.h + 20);
      });

      bgCtx.globalAlpha = 1;

      // --- CAMERA ---
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-camera.x, -camera.y);

      if (state.shake > 0) {
        ctx.translate(
          (Math.random() - 0.5) * state.shake,
          (Math.random() - 0.5) * state.shake
        );
      }

      // --- BUCKET ---
      ctx.shadowBlur = 10;
      ctx.shadowColor = CFG.colors.bucket;
      ctx.strokeStyle = CFG.colors.bucket;
      ctx.lineWidth = 3;
      ctx.strokeRect(bucket.x, bucket.y, bucket.w, bucket.h);

      ctx.fillStyle = "rgba(124, 138, 118, 0.3)";
      ctx.fillRect(bucket.x, bucket.y, bucket.w, bucket.h);
      ctx.shadowBlur = 0;

      // --- PEGS ---
      pegs.forEach(function (p) {
        if (p.scale < 0.1) return;

        const r = p.r * p.scale;

        let c = CFG.colors.green;
        if (p.type === "gold") c = CFG.colors.gold;
        if (p.type === "purple") c = CFG.colors.purple;

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = c;

        if (!p.hit) {
          ctx.shadowBlur = 6;
          ctx.shadowColor = c;
        }

        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fill();
      });

      // --- BALLS ---
      balls.forEach(function (b) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, CFG.ballRadius, 0, Math.PI * 2);
        ctx.fillStyle = CFG.colors.ball;
        ctx.shadowBlur = 8;
        ctx.shadowColor = CFG.colors.ball;
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      // --- PARTICLES ---
      particles.forEach(function (p) {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.fillStyle = p.c;
        ctx.fillRect(p.x, p.y, 4, 4);
      });

      ctx.globalAlpha = 1;

      // --- FLOATING TEXT ---
      floats.forEach(function (f) {
        ctx.font = "bold " + (f.size || 18) + "px Inter, sans-serif";
        ctx.fillStyle = f.c;
        ctx.globalAlpha = Math.max(0, Math.min(1, f.life));
        ctx.fillText(f.txt, f.x, f.y);
      });

      ctx.globalAlpha = 1;

      // --- AIMING ARC ---
      // The old version drew a straight ray, which ignored gravity and so
      // pointed somewhere the ball could never go. This simulates the real
      // launch and stops dead at the first peg, so the entry is honest and
      // everything after first contact stays unknown.
      if (state.aiming) {
        const path = predictPath();

        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x, path[i].y);
        }

        ctx.strokeStyle = "rgba(240, 232, 215, 0.4)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Marker where control ends.
        const last = path[path.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(240, 232, 215, 0.55)";
        ctx.fill();

        // Muzzle.
        ctx.beginPath();
        ctx.arc(cannon.x, cannon.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = CFG.colors.ball;
        ctx.fill();
      }

      ctx.restore();
    }

    // =======================
    // AIM PREDICTION
    // =======================
    function predictPath() {
      const R = CFG.ballRadius;

      let x = cannon.x;
      let y = cannon.y;
      let vx = Math.cos(cannon.angle) * CFG.launchSpeed;
      let vy = Math.sin(cannon.angle) * CFG.launchSpeed;

      const path = [{ x: x, y: y }];

      for (let i = 0; i < CFG.aimSteps; i++) {
        vy += CFG.gravity;
        x += vx;
        y += vy;
        vx *= CFG.friction;
        vy *= CFG.friction;

        if (x < R) {
          x = R;
          vx = Math.abs(vx) * CFG.wallBounce;
        }
        if (x > width - R) {
          x = width - R;
          vx = -Math.abs(vx) * CFG.wallBounce;
        }

        path.push({ x: x, y: y });

        if (y > height) break;

        let contact = false;
        for (let j = 0; j < pegs.length; j++) {
          const p = pegs[j];
          if (p.hit) continue;
          if (Math.hypot(x - p.x, y - p.y) < R + p.r) {
            contact = true;
            break;
          }
        }

        if (contact) break;
      }

      return path;
    }

    // =======================
    // GAME STATUS
    // =======================
    function checkGameStatus() {
      if (balls.length > 0 || state.aiming) return;

      const goldLeft = pegs.filter(function (p) {
        return p.type === "gold" && !p.hit;
      }).length;

      if (goldLeft === 0) {
        const finished = state.level;
        state.level++;

        showMenu(
          "Round Complete",
          "All Gold Chips cleared.",
          "Next Round",
          "next"
        );
      } else if (state.balls <= 0) {
        sfx("liquidated");

        showMenu(
          "Round Over",
          "No Trades Remaining.",
          "Try Again",
          "retry"
        );
      } else {
        state.aiming = true;
        state.multiplier = 1;

        pegs = pegs.filter(function (p) {
          return !p.hit;
        });

        if (pendingRebuild) rebuildBoard();

        updateUI();
      }
    }

    // =======================
    // UI
    // =======================
    function updateUI() {
      state.pegsLeft = pegs.filter(function (p) {
        return p.type === "gold" && !p.hit;
      }).length;

      if (uiScore) uiScore.textContent = state.score.toLocaleString();
      if (uiPegs) uiPegs.textContent = state.pegsLeft;
      if (uiBalls) uiBalls.textContent = state.balls;

      // The combo multiplier was applied to every hit but never displayed,
      // so the score jumped with no visible reason.
      if (uiMult) {
        // hidden (not visibility) so the score stays centred when no combo.
        if (state.multiplier > 1) {
          uiMult.textContent = "\u00d7" + state.multiplier;
          uiMult.hidden = false;
        } else {
          uiMult.hidden = true;
        }
      }
    }

    // =======================
    // EFFECTS
    // =======================
    function spawnParticles(x, y, c) {
      for (let i = 0; i < 6; i++) {
        particles.push({
          x: x,
          y: y,
          vx: (Math.random() - 0.5) * 5,
          vy: (Math.random() - 0.5) * 5,
          c: c,
          life: 1
        });
      }
    }

    function addFloat(x, y, txt, c, size) {
      const s = size || 18;
      const text = String(txt);

      ctx.font = "bold " + s + "px Inter, sans-serif";
      const half = ctx.measureText(text).width / 2;

      let safeX = Math.max(half + 10, Math.min(width - half - 10, x));
      safeX -= half;

      floats.push({ x: safeX, y: y, txt: text, c: c, life: 1, size: s });
    }

    // =======================
    // INPUT
    // =======================
    function pointerPos(e) {
      const rect = cvs.getBoundingClientRect();

      // touchend carries the finger position in changedTouches, not touches.
      const t =
        (e.touches && e.touches[0]) ||
        (e.changedTouches && e.changedTouches[0]);

      const clientX = t ? t.clientX : e.clientX;
      const clientY = t ? t.clientY : e.clientY;

      return {
        x: (clientX - rect.left) * (width / rect.width),
        y: (clientY - rect.top) * (height / rect.height)
      };
    }

    function aimAt(p) {
      let angle = Math.atan2(p.y - cannon.y, p.x - cannon.x);

      // Keep the shot pointing into the board rather than straight back up.
      const minSin = 0.15;
      if (Math.sin(angle) < minSin) {
        const cosSign = Math.cos(angle) >= 0 ? 1 : -1;
        angle = Math.atan2(minSin, cosSign * Math.sqrt(1 - minSin * minSin));
      }

      cannon.angle = angle;
    }

    function fire() {
      if (!isGameRunning || !state.aiming || state.balls <= 0) return;

      state.aiming = false;
      state.balls--;
      state.multiplier = 1;
      sfx("shoot");

      balls.push({
        x: cannon.x,
        y: cannon.y,
        vx: Math.cos(cannon.angle) * CFG.launchSpeed,
        vy: Math.sin(cannon.angle) * CFG.launchSpeed,
        age: 0,
        active: true
      });

      updateUI();
    }

    // ---- Mouse: move to aim, press to fire ----
    plinkoWrapper.addEventListener("mousemove", function (e) {
      if (!isGameRunning || !state.aiming) return;
      aimAt(pointerPos(e));
    });

    plinkoWrapper.addEventListener("mousedown", function (e) {
      // Only the main button fires; right-click used to shoot as well.
      if (e.button !== 0) return;
      if (!isGameRunning || !state.aiming || state.balls <= 0) return;
      aimAt(pointerPos(e));
      if (e.cancelable) e.preventDefault();
      fire();
    });

    plinkoWrapper.addEventListener("contextmenu", function (e) {
      if (isGameRunning) e.preventDefault();
    });

    // ---- Touch: drag to aim, lift to fire ----
    // Firing on touchstart made aiming impossible on a phone, since the shot
    // left before the finger could be moved anywhere useful.
    let touchAiming = false;

    plinkoWrapper.addEventListener(
      "touchstart",
      function (e) {
        if (!isGameRunning || !state.aiming) return;
        touchAiming = true;
        aimAt(pointerPos(e));
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );

    plinkoWrapper.addEventListener(
      "touchmove",
      function (e) {
        if (!touchAiming || !isGameRunning || !state.aiming) return;
        aimAt(pointerPos(e));
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );

    plinkoWrapper.addEventListener(
      "touchend",
      function (e) {
        if (!touchAiming) return;
        touchAiming = false;

        if (!isGameRunning || !state.aiming || state.balls <= 0) return;
        aimAt(pointerPos(e));
        if (e.cancelable) e.preventDefault();
        fire();
      },
      { passive: false }
    );

    plinkoWrapper.addEventListener("touchcancel", function () {
      touchAiming = false;
    });

    // =======================
    // LIFECYCLE
    // =======================
    let resizeTimer = null;
    window.addEventListener("resize", function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        resize();
        if (!isGameRunning) draw();
      }, 120);
    });

    // Browsers suspend the audio context when the tab is backgrounded.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(function () {});
      }
    });

    // =======================
    // INIT
    // =======================
    resize();
    updateUI();

    // The HUD gets slightly taller once Inter loads, so re-place the cannon.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        resize();
        if (!isGameRunning) draw();
      });
    }

    menuMode = "new";
    menuLayer.style.display = "flex";
    window.setTimeout(function () {
      menuLayer.style.opacity = "1";
    }, 10);
  }

  // Boot immediately if the DOM is already parsed (e.g. the script was
  // deferred by a caching layer), otherwise wait for DOMContentLoaded.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
