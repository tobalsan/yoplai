import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expandHomePlaceholder,
  getDefaultConfigPath,
  readEnv,
  resetConfigPathWarningsForTests,
  resolveConfigPath,
  resolveHomeDir,
} from "../config-path.js";

describe("config path helpers", () => {
  const prevConfig = process.env.YOPLAI_CONFIG;
  const prevHome = process.env.YOPLAI_HOME;
  const prevLegacyConfig = process.env.AIHUB_CONFIG;
  const prevLegacyHome = process.env.AIHUB_HOME;

  beforeEach(() => {
    resetConfigPathWarningsForTests();
  });

  afterEach(() => {
    if (prevConfig === undefined) delete process.env.YOPLAI_CONFIG;
    else process.env.YOPLAI_CONFIG = prevConfig;
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
    if (prevLegacyConfig === undefined) delete process.env.AIHUB_CONFIG;
    else process.env.AIHUB_CONFIG = prevLegacyConfig;
    if (prevLegacyHome === undefined) delete process.env.AIHUB_HOME;
    else process.env.AIHUB_HOME = prevLegacyHome;
    vi.restoreAllMocks();
  });

  it("returns the default home and config path", () => {
    delete process.env.YOPLAI_HOME;
    delete process.env.YOPLAI_CONFIG;
    delete process.env.AIHUB_HOME;
    delete process.env.AIHUB_CONFIG;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-config-path-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    try {
      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".yoplai"));
      expect(getDefaultConfigPath()).toBe(
        path.join(tmpHome, ".yoplai", "yoplai.json")
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("prefers explicit config path", () => {
    process.env.YOPLAI_CONFIG = "/tmp/from-env.json";

    expect(resolveConfigPath("/tmp/from-arg.json")).toBe(
      path.resolve("/tmp/from-arg.json")
    );
  });

  it("uses YOPLAI_HOME for home and default config path", () => {
    process.env.YOPLAI_HOME = "~/custom-home";
    delete process.env.YOPLAI_CONFIG;

    expect(resolveHomeDir()).toBe(path.join(os.homedir(), "custom-home"));
    expect(getDefaultConfigPath()).toBe(
      path.join(os.homedir(), "custom-home", "yoplai.json")
    );
    expect(resolveConfigPath()).toBe(
      path.join(os.homedir(), "custom-home", "yoplai.json")
    );
  });

  it("falls back to YOPLAI_CONFIG directory with a deprecation warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.YOPLAI_CONFIG = "~/custom/yoplai.json";
    delete process.env.YOPLAI_HOME;

    expect(resolveHomeDir()).toBe(path.join(os.homedir(), "custom"));
    expect(getDefaultConfigPath()).toBe(
      path.join(os.homedir(), "custom", "yoplai.json")
    );
    expect(resolveConfigPath()).toBe(
      path.join(os.homedir(), "custom", "yoplai.json")
    );
    expect(warn).toHaveBeenCalledWith(
      "[config] YOPLAI_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
    );
  });

  it("falls back to AIHUB_HOME with a deprecation warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.YOPLAI_HOME;
    delete process.env.YOPLAI_CONFIG;
    process.env.AIHUB_HOME = "~/legacy-home";

    expect(resolveHomeDir()).toBe(path.join(os.homedir(), "legacy-home"));
    expect(warn).toHaveBeenCalledWith(
      "[config] AIHUB_HOME is deprecated; set YOPLAI_HOME instead."
    );
  });

  it("prefers YOPLAI_HOME over AIHUB_HOME", () => {
    process.env.YOPLAI_HOME = "~/new-home";
    process.env.AIHUB_HOME = "~/legacy-home";

    expect(resolveHomeDir()).toBe(path.join(os.homedir(), "new-home"));
  });

  it("falls back to AIHUB_CONFIG directory with a deprecation warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.YOPLAI_HOME;
    delete process.env.YOPLAI_CONFIG;
    delete process.env.AIHUB_HOME;
    process.env.AIHUB_CONFIG = "~/legacy/aihub.json";

    expect(resolveHomeDir()).toBe(path.join(os.homedir(), "legacy"));
    expect(warn).toHaveBeenCalledWith(
      "[config] AIHUB_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
    );
  });

  describe("filesystem-backed default rungs", () => {
    let tmpHome: string;

    beforeEach(() => {
      delete process.env.YOPLAI_HOME;
      delete process.env.YOPLAI_CONFIG;
      delete process.env.AIHUB_HOME;
      delete process.env.AIHUB_CONFIG;
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-config-path-"));
      vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    });

    afterEach(() => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    const writeConfig = (dirName: string, fileName: string) => {
      const dir = path.join(tmpHome, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fileName), "{}");
      return dir;
    };

    it("defaults to ~/.yoplai when neither home dir exists", () => {
      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".yoplai"));
    });

    it("falls back to ~/.aihub when only it holds a config, with a warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeConfig(".aihub", "aihub.json");

      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".aihub"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Using legacy")
      );
    });

    it("keeps the legacy home when ~/.yoplai exists but holds no config", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fs.mkdirSync(path.join(tmpHome, ".yoplai"));
      writeConfig(".aihub", "aihub.json");

      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".aihub"));
      expect(getDefaultConfigPath()).toBe(
        path.join(tmpHome, ".aihub", "aihub.json")
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Using legacy")
      );
    });

    it("defaults to ~/.yoplai when both dirs exist but neither holds a config", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fs.mkdirSync(path.join(tmpHome, ".yoplai"));
      fs.mkdirSync(path.join(tmpHome, ".aihub"));

      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".yoplai"));
      expect(warn).not.toHaveBeenCalled();
    });

    it("prefers ~/.yoplai when both home dirs hold a config", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeConfig(".yoplai", "yoplai.json");
      writeConfig(".aihub", "aihub.json");

      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".yoplai"));
      expect(getDefaultConfigPath()).toBe(
        path.join(tmpHome, ".yoplai", "yoplai.json")
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("prefers a legacy-named config in ~/.yoplai over ~/.aihub", () => {
      writeConfig(".yoplai", "aihub.json");
      writeConfig(".aihub", "aihub.json");

      expect(resolveHomeDir()).toBe(path.join(tmpHome, ".yoplai"));
    });

    it("prefers yoplai.json over aihub.json when both exist", () => {
      const homeDir = path.join(tmpHome, ".yoplai");
      fs.mkdirSync(homeDir);
      fs.writeFileSync(path.join(homeDir, "yoplai.json"), "{}");
      fs.writeFileSync(path.join(homeDir, "aihub.json"), "{}");

      expect(getDefaultConfigPath()).toBe(path.join(homeDir, "yoplai.json"));
    });

    it("falls back to aihub.json when yoplai.json is absent, with a warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const homeDir = path.join(tmpHome, ".yoplai");
      fs.mkdirSync(homeDir);
      fs.writeFileSync(path.join(homeDir, "aihub.json"), "{}");

      expect(getDefaultConfigPath()).toBe(path.join(homeDir, "aihub.json"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Using legacy"));
    });
  });

  describe("expandHomePlaceholder", () => {
    const homeDir = path.join(path.sep, "home", "user", ".yoplai");

    it("expands $YOPLAI_HOME in a config value without warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(expandHomePlaceholder("$YOPLAI_HOME/agents/*", homeDir)).toBe(
        `${homeDir}/agents/*`
      );
      expect(expandHomePlaceholder("$YOPLAI_HOME", homeDir)).toBe(homeDir);
      expect(warn).not.toHaveBeenCalled();
    });

    it("expands legacy $AIHUB_HOME with a deprecation warning, once", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(expandHomePlaceholder("$AIHUB_HOME/agents/*", homeDir)).toBe(
        `${homeDir}/agents/*`
      );
      expect(warn).toHaveBeenCalledWith(
        "[config] $AIHUB_HOME in config values is deprecated; rewrite it as $YOPLAI_HOME."
      );

      warn.mockClear();
      expect(expandHomePlaceholder("$AIHUB_HOME", homeDir)).toBe(homeDir);
      expect(warn).not.toHaveBeenCalled();
    });

    it("leaves values without the placeholder untouched", () => {
      expect(expandHomePlaceholder("./agents/*", homeDir)).toBe("./agents/*");
      expect(expandHomePlaceholder("$AIHUB_HOMEX/agents", homeDir)).toBe(
        "$AIHUB_HOMEX/agents"
      );
      expect(expandHomePlaceholder("prefix/$YOPLAI_HOME/agents", homeDir)).toBe(
        "prefix/$YOPLAI_HOME/agents"
      );
    });
  });

  describe("readEnv", () => {
    afterEach(() => {
      delete process.env.YOPLAI_FOO;
      delete process.env.AIHUB_FOO;
    });

    it("reads YOPLAI_<X> when set", () => {
      process.env.YOPLAI_FOO = "new-value";
      process.env.AIHUB_FOO = "old-value";

      expect(readEnv("FOO")).toBe("new-value");
      expect(readEnv("YOPLAI_FOO")).toBe("new-value");
    });

    it("falls back to AIHUB_<X> with a deprecation warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env.YOPLAI_FOO;
      process.env.AIHUB_FOO = "old-value";

      expect(readEnv("FOO")).toBe("old-value");
      expect(warn).toHaveBeenCalledWith(
        "[config] AIHUB_FOO is deprecated; set YOPLAI_FOO instead."
      );
    });

    it("returns undefined when neither is set", () => {
      delete process.env.YOPLAI_FOO;
      delete process.env.AIHUB_FOO;

      expect(readEnv("FOO")).toBeUndefined();
    });
  });

  describe("warn-once guards", () => {
    it("warns about deprecated AIHUB_HOME exactly once across repeated calls, without suppressing AIHUB_CONFIG's warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env.YOPLAI_HOME;
      delete process.env.YOPLAI_CONFIG;
      process.env.AIHUB_HOME = "~/legacy-home";
      delete process.env.AIHUB_CONFIG;

      resolveHomeDir();
      resolveHomeDir();
      resolveHomeDir();

      const homeWarnings = warn.mock.calls.filter(
        (call) => call[0] === "[config] AIHUB_HOME is deprecated; set YOPLAI_HOME instead."
      );
      expect(homeWarnings).toHaveLength(1);

      // A different rung (AIHUB_CONFIG) must still warn on its own.
      delete process.env.AIHUB_HOME;
      process.env.AIHUB_CONFIG = "~/legacy/aihub.json";
      resolveHomeDir();

      const configWarnings = warn.mock.calls.filter(
        (call) =>
          call[0] ===
          "[config] AIHUB_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
      );
      expect(configWarnings).toHaveLength(1);
    });

    it("warns about deprecated YOPLAI_CONFIG exactly once across repeated calls, without suppressing AIHUB_HOME's warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env.YOPLAI_HOME;
      process.env.YOPLAI_CONFIG = "~/custom/yoplai.json";
      delete process.env.AIHUB_HOME;
      delete process.env.AIHUB_CONFIG;

      resolveHomeDir();
      resolveHomeDir();
      resolveHomeDir();

      const configWarnings = warn.mock.calls.filter(
        (call) =>
          call[0] ===
          "[config] YOPLAI_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
      );
      expect(configWarnings).toHaveLength(1);

      // A different rung (AIHUB_HOME) must still warn on its own.
      delete process.env.YOPLAI_CONFIG;
      process.env.AIHUB_HOME = "~/legacy-home";
      resolveHomeDir();

      const homeWarnings = warn.mock.calls.filter(
        (call) => call[0] === "[config] AIHUB_HOME is deprecated; set YOPLAI_HOME instead."
      );
      expect(homeWarnings).toHaveLength(1);
    });

    it("warns about deprecated AIHUB_CONFIG exactly once across repeated calls, without suppressing YOPLAI_CONFIG's warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env.YOPLAI_HOME;
      delete process.env.YOPLAI_CONFIG;
      delete process.env.AIHUB_HOME;
      process.env.AIHUB_CONFIG = "~/legacy/aihub.json";

      resolveHomeDir();
      resolveHomeDir();
      resolveHomeDir();

      const configWarnings = warn.mock.calls.filter(
        (call) =>
          call[0] ===
          "[config] AIHUB_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
      );
      expect(configWarnings).toHaveLength(1);

      // A different rung (YOPLAI_CONFIG) must still warn on its own.
      delete process.env.AIHUB_CONFIG;
      process.env.YOPLAI_CONFIG = "~/custom/yoplai.json";
      resolveHomeDir();

      const currentConfigWarnings = warn.mock.calls.filter(
        (call) =>
          call[0] ===
          "[config] YOPLAI_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
      );
      expect(currentConfigWarnings).toHaveLength(1);
    });

    it("warns about the AIHUB_ prefix exactly once per suffix, without suppressing a different suffix's warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env.YOPLAI_FOO;
      delete process.env.YOPLAI_BAR;
      delete process.env.AIHUB_BAR;
      process.env.AIHUB_FOO = "old-value";

      try {
        readEnv("FOO");
        readEnv("FOO");
        readEnv("FOO");

        const fooWarnings = warn.mock.calls.filter(
          (call) => call[0] === "[config] AIHUB_FOO is deprecated; set YOPLAI_FOO instead."
        );
        expect(fooWarnings).toHaveLength(1);

        // A different suffix must still warn on its own.
        process.env.AIHUB_BAR = "old-value";
        readEnv("BAR");

        const barWarnings = warn.mock.calls.filter(
          (call) => call[0] === "[config] AIHUB_BAR is deprecated; set YOPLAI_BAR instead."
        );
        expect(barWarnings).toHaveLength(1);
      } finally {
        delete process.env.AIHUB_FOO;
        delete process.env.AIHUB_BAR;
      }
    });

    describe("filesystem-backed rungs", () => {
      let tmpHome: string;

      beforeEach(() => {
        delete process.env.YOPLAI_HOME;
        delete process.env.YOPLAI_CONFIG;
        delete process.env.AIHUB_HOME;
        delete process.env.AIHUB_CONFIG;
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-config-path-warn-"));
        vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
      });

      afterEach(() => {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      });

      it("warns about the legacy ~/.aihub home dir exactly once across repeated calls, without suppressing the legacy aihub.json filename warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const legacyDir = path.join(tmpHome, ".aihub");
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, "aihub.json"), "{}");

        resolveHomeDir();
        resolveHomeDir();
        resolveHomeDir();

        const dirWarnings = warn.mock.calls.filter(
          (call) =>
            typeof call[0] === "string" &&
            call[0].startsWith(`[config] Using legacy ${legacyDir}`)
        );
        expect(dirWarnings).toHaveLength(1);

        // A different rung (legacy aihub.json filename inside ~/.yoplai) must
        // still warn on its own, even though its message shares the "Using
        // legacy" prefix.
        const homeDir = path.join(tmpHome, ".yoplai");
        fs.mkdirSync(homeDir, { recursive: true });
        fs.writeFileSync(path.join(homeDir, "aihub.json"), "{}");
        getDefaultConfigPath();

        const filenameWarnings = warn.mock.calls.filter(
          (call) =>
            typeof call[0] === "string" &&
            call[0].startsWith(
              `[config] Using legacy ${path.join(homeDir, "aihub.json")}`
            )
        );
        expect(filenameWarnings).toHaveLength(1);
      });

      it("warns about the legacy aihub.json filename exactly once across repeated calls, without suppressing the legacy ~/.aihub home dir warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const homeDir = path.join(tmpHome, ".yoplai");
        fs.mkdirSync(homeDir, { recursive: true });
        fs.writeFileSync(path.join(homeDir, "aihub.json"), "{}");

        getDefaultConfigPath();
        getDefaultConfigPath();
        getDefaultConfigPath();

        const filenameWarnings = warn.mock.calls.filter(
          (call) =>
            typeof call[0] === "string" &&
            call[0].startsWith(
              `[config] Using legacy ${path.join(homeDir, "aihub.json")}`
            )
        );
        expect(filenameWarnings).toHaveLength(1);

        // A different rung (legacy ~/.aihub home dir) must still warn on its
        // own, even though its message shares the "Using legacy" prefix.
        fs.rmSync(homeDir, { recursive: true, force: true });
        const legacyDir = path.join(tmpHome, ".aihub");
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, "aihub.json"), "{}");
        resolveHomeDir();

        const dirWarnings = warn.mock.calls.filter(
          (call) =>
            typeof call[0] === "string" &&
            call[0].startsWith(`[config] Using legacy ${legacyDir}`)
        );
        expect(dirWarnings).toHaveLength(1);
      });
    });
  });
});
