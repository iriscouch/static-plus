var fs = require('fs')
  , tap = require('tap')
  , test = tap.test
  , util = require('util')
  , request = require('request')

var api = require('../api')
  , auto = api.defaults({autostart:true, autostop:true})
  , couch = require('./couch')

couch.setup(test)

test('Build to object', function(t) {
  t.ok(couch.rtt(), 'The request duration should be known')

  couch.add_doc('foo', 'tball', function() {
    var builder = new api.Builder('Build output')

    builder.source   = couch.DB
    builder.output   = {}
    builder.template = function(doc) { return doc._id + ' says ' + doc.value }

    var pages = 0;
    builder.on('page', function(page) {
      pages += 1
      t.equals(Object.keys(builder.output).length, pages, 'Should have '+pages+' pages built now')
    })

    t.doesNotThrow(function() { builder.start() }, 'No problem starting this builder')

    var deploy = null
    builder.on('deploy', function(output) { deploy = output })

    setTimeout(check_deploys, couch.rtt() * 2)
    function check_deploys() {
      t.doesNotThrow(function() { builder.stop() })

      t.ok(deploy, 'One deploy should have happened since the DB had one document')
      t.ok(deploy.foo, 'The document was deployed')
      t.equal(deploy.foo, 'foo says tball', 'Deployed "page" matches the template')

      t.end()
    }
  })
})

test('Build to files', function(t) {
  couch.add_doc('bar', 'camp', function() {
    var builder = new auto.Builder
    builder.source = couch.DB
    builder.output = 'files_build'
    builder.template = function(doc) { return doc._id + ': ' + doc.value }

    builder.on('deploy', function(path) {
      t.equal(path, 'files_build', 'Deploy to the same path as instructed')

      var files = process.cwd() + '/files_build'
      var found = fs.readdirSync(files)
      t.ok(~found.indexOf('foo.html'), 'Document "foo" was built as a file')
      t.ok(~found.indexOf('bar.html'), 'Document "bar" was built as a file')

      t.equal(fs.readFileSync(files+'/foo.html', 'utf8'), 'foo: tball', 'File for document "foo" looks good')
      t.equal(fs.readFileSync(files+'/bar.html', 'utf8'), 'bar: camp', 'File for document "bar" looks good')

      t.end()
    })
  })
})
