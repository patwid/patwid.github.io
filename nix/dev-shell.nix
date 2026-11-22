{ lib, ... }:
{
  perSystem =
    { config, pkgs, ... }:
    {
      options.devShellHooks = lib.mkOption {
        type = lib.types.lines;
        default = "";
        description = "Shell snippets run when entering the default dev shell.";
      };

      config.devShells.default = pkgs.mkShellNoCC {
        packages = [ pkgs.hugo ];
        shellHook = config.devShellHooks;
      };
    };
}
