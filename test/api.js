var fs = require('fs')
  , tap = require('tap')
  , test = tap.test
  , request = require('request')

var api = require('../api')
  , couch = require('./couch')
  , auto = api.defaults({ autostart:true, autostop:true, source:couch.DB })

couch.setup(test)

test('Builder API', function(t) {
  t.ok(couch.rtt(), 'The request duration should be known')

  var builder;

  t.doesNotThrow(function() { builder = new api.Builder }, 'Create a new builder')
  t.ok(builder, 'Got a builder object')

  function start() { builder.start() }

  var did = {}
  builder.on('template', function(template) { did.template = template })
  builder.on('output'  , function(output)   { did.output   = output   })
  builder.on('source'  , function(source)   { did.source   = source    })
  builder.on('start'   , function()         { did.start    = true     })

  builder.template = null
  t.throws(start, 'Throw for missing template')

  builder.template = 1;
  t.throws(start, 'Throw for bad template type')
  builder.template = function(doc) { return 'Doc!' }

  t.throws(start, 'Throw for missing source db')

  builder.source = 'not_a_url'
  t.throws(start, 'Throw for bad Couch URL')

  builder.source = couch.DB

  t.throws(start, 'Throw for missing output')
  builder.output = __dirname + '/../build_test/output'

  t.doesNotThrow(start, 'No throw for all good starting data')

  setTimeout(check_events, couch.rtt() * 1.5)

  function check_events() {
    t.ok(did.output, 'The output event finally fired')
    t.ok(did.template, 'The template event finally fired')
    t.ok(did.source, 'The source event finally fired')
    t.ok(did.start, 'The builder started')

    t.ok(builder.feed, 'The builder should have a feed by now')

    builder.stop()
    t.end()
  }
})

test('Autostart', function(t) {
  var builder = new api.Builder({ name:'Autostart', autostart:true })
  builder.source = couch.DB
  builder.output = {}
  builder.template = function() { return 'I autostarted!' }

  var events = { start:false, deploy:false }
  builder.on('start', function() { events.start = true })
  builder.on('deploy', function() { events.deploy = true })

  setTimeout(check_for_deploy, couch.rtt() * 2)
  function check_for_deploy() {
    t.ok(events.start, 'The builder should have started automatically')
    t.ok(events.deploy, 'The builder should have deployed by now')

    builder.stop()
    t.end()
  }
})

test('Autostop', function(t) {
  var builder = new api.Builder({ autostart:true, autostop:true })
  builder.source = couch.DB
  builder.output = {}
  builder.template = function() { return 'I autostop' }

  var stopped = false
  builder.on('stop', function() { stopped = true })

  setTimeout(check_for_stop, couch.rtt() * 2)
  function check_for_stop() {
    t.ok(stopped, 'The builder should have stopped by now')
    t.ok(builder.dead, 'The builder should be dead')
    t.ok(builder.feed.dead, "The builder's feed should be dead")
    t.end()
  }
})

test('Bad couch output', function(t) {
  var bad_urls = [ [ /ECONNREFUSED/    , 'http://localhost:10' ]
                 , [ /database URL/    , require('path').dirname(couch.DB) ]
                 , [ /not a document/  , couch.DB + '/doc_one/attachment'  ]     // These two errors are
                 , [ /CouchDB database/, couch.DB + '/doc/attachment/too_deep' ] // actually the same one.
                 ]

  test_url()
  function test_url() {
    var url = bad_urls.shift()
    if(!url)
      return t.end()

    var message = url[0]
    url = url[1]

    var error = null
    var builder = new auto.Builder({ 'template':couch.simple_tmpl, 'output':url })
    builder.on('error', function(er) { error = er })

    setTimeout(check_error, couch.rtt())
    function check_error() {
      t.ok(error, 'Bad URL should have caused an error: ' + url)
      t.ok(error.message.match(message), 'Bad url '+url+' caused error: ' + message)

      test_url() // Next one
    }
  }
})

test('Good couch output', function(t) {
  var doc_url = couch.DB + '/output'
  var builder = new auto.Builder({ 'template':couch.simple_tmpl, 'output':doc_url })

  var error = null
    , done = false
  builder.on('error', function(er) { error = er })
  builder.on('stop', function() { done = true })

  setTimeout(check_result, couch.rtt() * 2)
  function check_result() {
    return t.end()
    t.false(error, 'No errors for good doc url: ' + doc_url)
    t.ok(done, 'Builder finished with good doc_url')

    t.end()
  }
})
