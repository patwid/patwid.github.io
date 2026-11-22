# Renders every icon the site needs from the single source icons/icon.svg.
{
  perSystem =
    { pkgs, ... }:
    {
      packages.icons =
        pkgs.runCommand "icons"
          {
            src = ../icons/icon.svg;
            nativeBuildInputs = [
              pkgs.resvg
              pkgs.imagemagick
            ];
          }
          ''
            mkdir -p $out/images
            render() { resvg --width "$1" --height "$1" "$src" "$2"; }

            cp "$src" $out/favicon.svg
            render 180 $out/apple-touch-icon.png
            render 512 $out/images/icon.png

            for size in 16 32 48; do render $size ico-$size.png; done
            magick ico-16.png ico-32.png ico-48.png $out/favicon.ico
          '';
    };
}
