Semantic Studio
===============

Semantic Studio is an application for exploring and building ontologies and
vocabularies (RDF, OWL and SKOS) that runs on this computer and opens in your
web browser.

To start it, open "Start Semantic Studio"; to stop it, close the window that
opens with it.

Your work is kept in %LOCALAPPDATA%\semantic-studio (usually
C:\Users\<you>\AppData\Local\semantic-studio), never in this folder.

To update, unzip the new release anywhere and start it: your work is found
where it was, and the old folder can then be deleted.

Nothing is installed and no administrator rights are needed: the Python it
runs on is inside this folder, and nothing else on the computer is used.

It uses the address http://127.0.0.1:8000 (or the next free one, up to port
8019), which only this computer can reach.

It connects to the internet only when you allow it, uses Windows' proxy and
certificates on a company network, and Settings > Network has
"Test connection" to check that it gets through.


If Windows warns you
--------------------

This release is not signed, so Windows may say "Windows protected your PC" or
show a security warning when you open "Start Semantic Studio". Before
unzipping: right-click the zip, choose Properties, tick Unblock, click OK,
then unzip it.
