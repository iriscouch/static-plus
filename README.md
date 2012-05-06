# Static web site and web application builder

Static+ builds web sites from a data stream and some HTML templates.

It can deploy the site as files in your filesystem, an S3 or CloudFront site, or from CouchDB.

Static+ allows the following work flow:

    [CouchDB data] --> Static+ --+--> HTML5 files on your disk
                                 |
                                 or
                                 |
                                 +--> HTML5 attachments in CouchDB
                                 |
                                 or
                                 |
                                 +--> HTML5 files in S3/CloudFront (planned)
                                 |
                                 or
                                 |
                                 +--> HTML5 files in Dropbox (planned)

## Static deployment to CouchDB

Typically Static+ deploys a site to CouchDB.

*Wait, why would I round-trip from CouchDB and back?*

Because Static+ turns a **database full of data** into a **document full of attachments**. That's the "plus" part.

* Fast. No shows, no lists, no views. Every request is a static download from an attachment.
* Push to a staging URL for QA, promote into production with an atomic transaction
* Every path in the site is static, simple, and fast; with two exceptions:
  1. `/_couchdb` gives your site AJAX access to the CouchDB server hosting the site.
  2. `/_db` give your site AJAX access to the database hosting the site.

Personally, I (Jason) think this is the perfect Couch app. It is very scalable. It is very fast. It is very simple. The basic web site has zero moving parts. Then I use [Browser Request][breq] to access a simple, standard CouchDB API.

## Usage

Install it from NPM

    npm install static-plus

Static+ is flexible; however; its "beaten path" looks like this:

1. You define a [Handlebars] template
1. You define a **source database**. Static+ spits out (roughly) one web page per document.
1. You define a **target** and Static+ deploys the output to there. Valid targets:
   1. A directory in a filesystem
   2. S3. Just CNAME your domain there and you're done
   3. CouchDB attachments, **plus** access to the Couch API
1. Static+ watch the database `_changes` feed, updating the site when appropriate

## License

Apache 2.0

[handlebars]: http://handlebarsjs.com/
[breq]: https://github.com/iriscouch/browser-request/blob/master/test/push.js
