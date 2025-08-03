# -*- mode: shell-script -*-

depends org-ruby

##
## This conversion is done so that `npm publish` can display
## the content of the `README.org` correctly. Note that github
## supports `.org`. Notice that the API http page relies also
## on this.
##
org-ruby --translate markdown README.org > README.md.tmp
if diff README.md README.md.tmp > /dev/null; then
  echo "No changes in README.md" >&2
  rm README.md.tmp
else
  echo "Updating README.md" >&2
  mv README.md.tmp README.md
fi

cat CHANGELOG.md >> README.md
rm CHANGELOG.md
