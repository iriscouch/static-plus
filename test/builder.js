var tap = require('tap')
  , test = tap.test

var api = require('../api')

test('Builder API', function(t) {
  var builder;

  t.doesNotThrow(function() { builder = new api.Builder }, 'Create a new builder')
  t.ok(builder, 'Got a builder object')

  function start() { builder.start() }

  var did = {}
  builder.on('template', function(template) { did.template = template })
  builder.on('output'  , function(output)   { did.output   = output   })
  builder.on('couch'   , function(couch)    { did.couch    = couch    })
  builder.on('start'   , function()         { did.start    = true     })

  builder.template = null
  t.throws(start, 'Throw for missing template')
  t.notOk(did.template, 'Template not fired when missing')

  builder.template = 1;
  t.throws(start, 'Throw for bad template type')
  t.notOk(did.template, 'Template not fired when bad type')

  builder.template = function(doc) { return 'Doc!' }

  t.throws(start, 'Throw for missing output')
  t.ok(did.template, 'The template finally fired')
  t.notOk(did.output, 'But the output event still has not fired')

  builder.output = __dirname + '/output'
  t.throws(start, 'Throw for missing couch')
//  t.ok(did.output, 'But the output event fired')

  t.notOk(did.start, 'Did not start yet, after good template')

  setTimeout(check_events, 100)

  function check_events() {
    t.ok(did.output, 'The output event finally fired')
    t.end()
  }
})
